import type { ResolvedHdrOptions } from "./configuration.js";
import { readFileStreams, type Stream } from "./ffmpeg.js";

export type HdrKind = "hdr10" | "hlg" | "sdr";

export type ColorMetadata = {
  pixFmt?: string;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  colorRange?: string;
  bitDepth?: number;
};

export type ColorClassification = {
  kind: HdrKind;
  isHdr: boolean;
  /**
   * Missing or contradictory metadata. When non-empty the caller must either
   * fall back to SDR with a warning or refuse to process - never guess.
   */
  issues: string[];
  metadata: ColorMetadata;
};

export type ColorHandling = {
  classification: ColorClassification;
  /**
   * ffmpeg filter chain to append at decode time when HDR tone-mapping applies.
   * `undefined` means the legacy SDR decode path is used unchanged.
   */
  toneMapFilter?: string;
};

/**
 * Error thrown when a pipeline stage cannot handle the requested color
 * processing. `stage` names the pipeline stage that lacks support.
 */
export class UnsupportedColorError extends Error {
  stage: string;

  constructor(message: string, stage: string) {
    super(message);
    this.name = "UnsupportedColorError";
    this.stage = stage;
  }
}

const PQ_TRANSFER = "smpte2084";
const HLG_TRANSFER = "arib-std-b67";

function isUnspecified(value?: string) {
  return value == null || value === "unknown" || value === "unspecified";
}

// Derive effective primaries without guessing: only use the color matrix as a
// hint when it unambiguously implies a primaries set.
function effectivePrimaries(metadata: ColorMetadata) {
  if (!isUnspecified(metadata.colorPrimaries)) return metadata.colorPrimaries;
  if (metadata.colorSpace === "bt2020nc" || metadata.colorSpace === "bt2020c") return "bt2020";
  if (metadata.colorSpace === "bt709") return "bt709";
  return undefined;
}

export function classifyColor(metadata: ColorMetadata): ColorClassification {
  const issues: string[] = [];
  const { colorTransfer } = metadata;
  const primaries = effectivePrimaries(metadata);

  if (colorTransfer === PQ_TRANSFER || colorTransfer === HLG_TRANSFER) {
    const transferName = colorTransfer === PQ_TRANSFER ? "PQ (smpte2084)" : "HLG (arib-std-b67)";

    if (primaries == null) {
      issues.push(`transfer function is ${transferName} but color primaries metadata is missing`);
    } else if (primaries !== "bt2020") {
      issues.push(
        `conflicting color metadata: transfer function is ${transferName} but color primaries are '${primaries}' (expected 'bt2020')`,
      );
    }

    if (issues.length > 0) return { kind: "sdr", isHdr: false, issues, metadata };

    return {
      kind: colorTransfer === PQ_TRANSFER ? "hdr10" : "hlg",
      isHdr: true,
      issues,
      metadata,
    };
  }

  // No HDR transfer function signaled
  if (primaries === "bt2020" && isUnspecified(colorTransfer)) {
    issues.push("BT.2020 color gamut signaled without a transfer function");
  }

  return { kind: "sdr", isHdr: false, issues, metadata };
}

export function extractColorMetadata(stream: Stream): ColorMetadata {
  const bitDepth = stream.bits_per_raw_sample
    ? parseInt(stream.bits_per_raw_sample, 10)
    : undefined;
  return {
    pixFmt: stream.pix_fmt,
    colorPrimaries: stream.color_primaries,
    colorTransfer: stream.color_transfer,
    colorSpace: stream.color_space,
    colorRange: stream.color_range,
    bitDepth: bitDepth != null && !Number.isNaN(bitDepth) ? bitDepth : undefined,
  };
}

/**
 * Builds the decode-time filter chain that converts an HDR stream to SDR
 * (BT.709). HDR10 (PQ) and HLG intentionally use different strategies:
 * - HDR10: linearize PQ, run the configurable tonemap operator, re-encode as BT.709
 * - HLG: direct transfer/primaries conversion via zscale (BT.2408 style), no tonemap operator
 */
export function buildToneMapFilter(
  kind: "hdr10" | "hlg",
  toneMapping: ResolvedHdrOptions["toneMapping"],
): string {
  if (kind === "hdr10") {
    const tonemapArgs = [`tonemap=${toneMapping.algorithm}`];
    if (toneMapping.param != null) tonemapArgs.push(`param=${toneMapping.param}`);
    if (toneMapping.desat != null) tonemapArgs.push(`desat=${toneMapping.desat}`);
    if (toneMapping.peak != null) tonemapArgs.push(`peak=${toneMapping.peak}`);
    return [
      "zscale=tin=smpte2084:t=linear:pin=bt2020:p=bt2020:min=bt2020nc:m=bt2020nc:npl=100",
      tonemapArgs.join(":"),
      "zscale=t=bt709:p=bt709:m=bt709:r=tv",
      "format=rgba",
    ].join(",");
  }

  // HLG
  return [
    "zscale=tin=arib-std-b67:t=bt709:pin=bt2020:p=bt709:min=bt2020nc:m=bt709:r=tv",
    "format=rgba",
  ].join(",");
}

// Cache resolved handling per (path, hdr config) so each asset is only
// probed/classified once per edit run, no matter how often it is referenced.
const colorHandlingCache = new Map<string, Promise<ColorHandling>>();

async function resolveColorHandlingUncached(
  path: string,
  hdr: ResolvedHdrOptions,
): Promise<ColorHandling> {
  const streams = await readFileStreams(path);
  const videoStream = streams.find((s) => s.codec_type === "video");
  if (!videoStream) throw new Error(`Could not find a video stream in ${path}`);

  const classification = classifyColor(extractColorMetadata(videoStream));

  if (classification.issues.length > 0) {
    const message = `${path}: ${classification.issues.join("; ")}`;
    if (hdr.onMissingMetadata === "error") {
      throw new UnsupportedColorError(
        `Refusing to guess color handling: ${message}. Fix the file metadata or set hdr.onMissingMetadata to 'warn' to treat it as SDR.`,
        "probe",
      );
    }
    console.warn(`WARNING: ${message} - treating as SDR`);
    return { classification };
  }

  if (!classification.isHdr) return { classification };

  if (hdr.mode === "passthrough") {
    throw new UnsupportedColorError(
      `HDR passthrough requested for ${path} (${classification.kind}), but the compositor stage uses 8-bit RGBA buffers which cannot carry 10-bit HDR without silent truncation. Use hdr.mode 'toneMap' (default) instead.`,
      "compositor",
    );
  }

  const toneMapFilter = buildToneMapFilter(classification.kind as "hdr10" | "hlg", hdr.toneMapping);
  console.log(
    `HDR input detected: ${path} (${classification.kind.toUpperCase()}, ${classification.metadata.colorPrimaries}/${classification.metadata.colorTransfer}), tone-mapping to SDR (bt709)`,
  );
  return { classification, toneMapFilter };
}

export function resolveColorHandling(
  path: string,
  hdr: ResolvedHdrOptions,
): Promise<ColorHandling> {
  const key = `${path}${JSON.stringify(hdr)}`;
  let cached = colorHandlingCache.get(key);
  if (!cached) {
    cached = resolveColorHandlingUncached(path, hdr);
    cached.catch(() => colorHandlingCache.delete(key));
    colorHandlingCache.set(key, cached);
  }
  return cached;
}

// Mostly for tests
export function clearColorHandlingCache() {
  colorHandlingCache.clear();
}

/**
 * Probes all unique video paths up-front (before any output is written) so
 * that unsupported configurations fail fast and the output encoder can be
 * configured correctly.
 */
export async function planHdrHandling(paths: string[], hdr: ResolvedHdrOptions) {
  let anyToneMapped = false;
  if (hdr.enabled) {
    for (const path of new Set(paths)) {
      const handling = await resolveColorHandling(path, hdr);
      if (handling.toneMapFilter) anyToneMapped = true;
    }
  }
  return { anyToneMapped };
}

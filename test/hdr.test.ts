import { execa } from "execa";
import fsExtra from "fs-extra";
import { join } from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildToneMapFilter, classifyColor } from "../src/color.js";
import { Configuration, type ConfigurationOptions } from "../src/configuration.js";
import { getDecodeCacheStats, resetDecodeCacheStats } from "../src/decodeCache.js";
import { ffprobe } from "../src/ffmpeg.js";
import Editly from "../src/index.js";

const tmpDir = fileURLToPath(new URL(".tmp-hdr", import.meta.url));
const assets = {
  hdr10: join(tmpDir, "hdr10.mp4"),
  hlg: join(tmpDir, "hlg.mp4"),
  sdr: join(tmpDir, "sdr.mp4"),
  broken: join(tmpDir, "broken.mp4"),
};

async function generateAssets() {
  await fsExtra.mkdirp(tmpDir);
  const lavfi = "testsrc2=size=128x128:rate=25:duration=2";
  const x265 = ["-pix_fmt", "yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast"];

  // HDR10: BT.2020 primaries + PQ transfer
  await execa("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    lavfi,
    ...x265,
    "-x265-params",
    "log-level=error:colorprim=9:transfer=16:colormatrix=9:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400",
    "-y",
    assets.hdr10,
  ]);

  // HLG: BT.2020 primaries + HLG transfer
  await execa("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    lavfi,
    ...x265,
    "-x265-params",
    "log-level=error:colorprim=9:transfer=18:colormatrix=9",
    "-y",
    assets.hlg,
  ]);

  // SDR: BT.709
  await execa("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    lavfi,
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "18",
    "-color_primaries",
    "1",
    "-color_trc",
    "1",
    "-colorspace",
    "1",
    "-y",
    assets.sdr,
  ]);

  // Broken metadata: BT.2020 gamut but no transfer function
  await execa("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    lavfi,
    ...x265,
    "-x265-params",
    "log-level=error:colorprim=9:colormatrix=9",
    "-y",
    assets.broken,
  ]);
}

async function probeOutputColor(path: string) {
  const { stdout } = await ffprobe([
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=color_space,color_transfer,color_primaries",
    "-of",
    "json",
    path,
  ]);
  const stream = JSON.parse(stdout).streams[0];
  return {
    colorSpace: stream.color_space ?? "unknown",
    colorTransfer: stream.color_transfer ?? "unknown",
    colorPrimaries: stream.color_primaries ?? "unknown",
  };
}

const videoClip = (path: string, duration = 1) => ({
  duration,
  layers: [{ type: "video" as const, path }],
});

const baseConfig = (outName: string) => ({
  outPath: join(tmpDir, outName),
  fast: true,
  defaults: { transition: { duration: 0.2, name: "fade" } },
});

beforeAll(async () => {
  await fsExtra.remove(tmpDir);
  await generateAssets();
}, 120_000);

afterAll(async () => {
  await fsExtra.remove(tmpDir);
});

describe("classifyColor", () => {
  test("detects HDR10 (PQ + BT.2020)", () => {
    const result = classifyColor({
      colorTransfer: "smpte2084",
      colorPrimaries: "bt2020",
      colorSpace: "bt2020nc",
    });
    expect(result.kind).toBe("hdr10");
    expect(result.isHdr).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("detects HLG (arib-std-b67 + BT.2020)", () => {
    const result = classifyColor({
      colorTransfer: "arib-std-b67",
      colorPrimaries: "bt2020",
      colorSpace: "bt2020nc",
    });
    expect(result.kind).toBe("hlg");
    expect(result.isHdr).toBe(true);
  });

  test("treats BT.709 as SDR without issues", () => {
    const result = classifyColor({
      colorTransfer: "bt709",
      colorPrimaries: "bt709",
      colorSpace: "bt709",
    });
    expect(result.kind).toBe("sdr");
    expect(result.issues).toEqual([]);
  });

  test("treats fully unspecified metadata as SDR without issues", () => {
    const result = classifyColor({});
    expect(result.kind).toBe("sdr");
    expect(result.issues).toEqual([]);
  });

  test("flags conflicting HDR metadata and falls back to SDR", () => {
    const result = classifyColor({
      colorTransfer: "smpte2084",
      colorPrimaries: "bt709",
      colorSpace: "bt709",
    });
    expect(result.kind).toBe("sdr");
    expect(result.isHdr).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test("flags BT.2020 gamut without transfer function", () => {
    const result = classifyColor({ colorPrimaries: "bt2020", colorSpace: "bt2020nc" });
    expect(result.kind).toBe("sdr");
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("buildToneMapFilter", () => {
  const toneMapping = { algorithm: "hable" as const };

  test("HDR10 uses PQ linearization + configurable tonemap operator", () => {
    const filter = buildToneMapFilter("hdr10", toneMapping);
    expect(filter).toContain("smpte2084");
    expect(filter).toContain("tonemap=hable");
    expect(filter).toContain("t=bt709");
  });

  test("HLG uses a different strategy than HDR10 (no tonemap operator)", () => {
    const filter = buildToneMapFilter("hlg", toneMapping);
    expect(filter).toContain("arib-std-b67");
    expect(filter).not.toContain("tonemap=");
    expect(filter).not.toBe(buildToneMapFilter("hdr10", toneMapping));
  });

  test("tonemap parameters are configurable", () => {
    const filter = buildToneMapFilter("hdr10", {
      algorithm: "mobius",
      param: 0.5,
      desat: 1.5,
      peak: 400,
    });
    expect(filter).toContain("tonemap=mobius");
    expect(filter).toContain("param=0.5");
    expect(filter).toContain("desat=1.5");
    expect(filter).toContain("peak=400");
  });
});

describe("Configuration hdr options", () => {
  const input: ConfigurationOptions = {
    outPath: "test.mp4",
    clips: [{ layers: [{ type: "title", text: "Hello World" }] }],
  };

  test("defaults preserve current behavior (auto-detect, toneMap, hable, warn)", () => {
    const config = new Configuration(input);
    expect(config.hdr).toEqual({
      enabled: true,
      mode: "toneMap",
      toneMapping: { algorithm: "hable", param: undefined, desat: undefined, peak: undefined },
      onMissingMetadata: "warn",
    });
  });

  test("validates hdr option values", () => {
    expect(() => new Configuration({ ...input, hdr: { mode: "bogus" } } as never)).toThrow(
      /hdr\.mode/,
    );
    expect(
      () => new Configuration({ ...input, hdr: { toneMapping: { algorithm: "bogus" } } } as never),
    ).toThrow(/hdr\.toneMapping\.algorithm/);
    expect(
      () => new Configuration({ ...input, hdr: { onMissingMetadata: "bogus" } } as never),
    ).toThrow(/hdr\.onMissingMetadata/);
  });
});

describe("HDR pipeline", () => {
  test("HDR10 input is tone-mapped and output is tagged BT.709", async () => {
    const config = baseConfig("hdr10-out.mp4");
    await Editly({ ...config, clips: [videoClip(assets.hdr10)] });
    expect(await probeOutputColor(config.outPath)).toEqual({
      colorSpace: "bt709",
      colorTransfer: "bt709",
      colorPrimaries: "bt709",
    });
  }, 120_000);

  test("HLG input is tone-mapped and output is tagged BT.709", async () => {
    const config = baseConfig("hlg-out.mp4");
    await Editly({ ...config, clips: [videoClip(assets.hlg)] });
    expect(await probeOutputColor(config.outPath)).toEqual({
      colorSpace: "bt709",
      colorTransfer: "bt709",
      colorPrimaries: "bt709",
    });
  }, 120_000);

  test("SDR input produces identical output with HDR pipeline on and off", async () => {
    const on = baseConfig("sdr-on.mp4");
    const off = baseConfig("sdr-off.mp4");
    await Editly({ ...on, clips: [videoClip(assets.sdr)] });
    await Editly({ ...off, hdr: { enabled: false }, clips: [videoClip(assets.sdr)] });

    const [onData, offData] = await Promise.all([
      fsExtra.readFile(on.outPath),
      fsExtra.readFile(off.outPath),
    ]);
    expect(onData.equals(offData)).toBe(true);

    // Default output remains untagged, exactly like before the HDR pipeline existed
    expect(await probeOutputColor(on.outPath)).toEqual({
      colorSpace: "unknown",
      colorTransfer: "unknown",
      colorPrimaries: "unknown",
    });
  }, 120_000);

  test("passthrough mode fails fast with an actionable error and leaves no output file", async () => {
    const config = baseConfig("passthrough-out.mp4");
    await expect(
      Editly({
        ...config,
        hdr: { mode: "passthrough" },
        clips: [videoClip(assets.hdr10)],
      }),
    ).rejects.toThrow(/compositor|8-bit RGBA/i);
    expect(await fsExtra.pathExists(config.outPath)).toBe(false);
  }, 120_000);

  test("missing metadata: treated as SDR with a warning by default, rejected with 'error'", async () => {
    const warn = baseConfig("broken-warn.mp4");
    await expect(Editly({ ...warn, clips: [videoClip(assets.broken)] })).resolves.toBeUndefined();
    // Treated as SDR: output stays untagged like any SDR input
    expect((await probeOutputColor(warn.outPath)).colorTransfer).toBe("unknown");

    const strict = baseConfig("broken-error.mp4");
    await expect(
      Editly({
        ...strict,
        hdr: { onMissingMetadata: "error" },
        clips: [videoClip(assets.broken)],
      }),
    ).rejects.toThrow(/Refusing to guess color handling/);
    expect(await fsExtra.pathExists(strict.outPath)).toBe(false);
  }, 120_000);

  test("a video referenced multiple times is only decoded once", async () => {
      resetDecodeCacheStats();
      const config = baseConfig("decode-once.mp4");
      await Editly({
        ...config,
        // No transitions, so the 3rd clip's frame source is only created
        // after the 1st clip finished decoding (deterministic cache hit)
        defaults: { transition: { duration: 0, name: "fade" } },
        clips: [
          videoClip(assets.sdr, 2),
          { duration: 1, layers: [{ type: "fill-color" as const, color: "#336699" }] },
        videoClip(assets.sdr, 2),
      ],
    });
    expect(await fsExtra.pathExists(config.outPath)).toBe(true);
    expect(getDecodeCacheStats()).toEqual({ ffmpegDecodes: 1, cacheHits: 1 });
  }, 120_000);
});

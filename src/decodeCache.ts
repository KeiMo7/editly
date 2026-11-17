import { createHash } from "crypto";
import { join } from "path";

/**
 * Decode-once cache. When the same video file is referenced by multiple
 * clips/layers, the decoded raw frames are stored in the edit's tmp dir the
 * first time the file is decoded, and subsequent references stream the frames
 * from the cache instead of spawning another ffmpeg decode.
 *
 * The cache only lives for the duration of one edit run (inside `tmpDir`,
 * which is removed afterwards unless `keepTmp` is set).
 */
export type DecodeCachePlan = {
  tmpDir: string;
  /**
   * Paths referenced more than once. Only these are worth caching, so
   * single-use files keep the exact legacy behavior (no disk overhead).
   */
  cacheablePaths: ReadonlySet<string>;
};

export function createDecodeCachePlan({
  videoPaths,
  tmpDir,
}: {
  videoPaths: string[];
  tmpDir: string;
}): DecodeCachePlan {
  const counts = new Map<string, number>();
  for (const path of videoPaths) counts.set(path, (counts.get(path) ?? 0) + 1);
  const cacheablePaths = new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([path]) => path),
  );
  return { tmpDir, cacheablePaths };
}

/**
 * The cache key covers every parameter that influences the decoded bytes, so
 * different cuts/sizes/color handling of the same file never collide.
 */
export function getDecodeCacheKey(params: {
  path: string;
  cutFrom?: number;
  cutTo?: number;
  speedFactor?: number;
  framerateStr: string;
  targetWidth: number;
  targetHeight: number;
  toneMapFilter?: string;
}) {
  return createHash("sha1").update(JSON.stringify(params)).digest("hex");
}

export function getDecodeCachePaths(plan: DecodeCachePlan, key: string) {
  const frameFile = join(plan.tmpDir, `editly-decode-cache-${key}.rgba`);
  return { frameFile, doneFile: `${frameFile}.done` };
}

// Stats are exported so tests (and users, via verbose logging) can verify
// that a multiply-referenced asset is really only decoded once.
const stats = { ffmpegDecodes: 0, cacheHits: 0 };

export function noteFfmpegDecode() {
  stats.ffmpegDecodes += 1;
}

export function noteCacheHit() {
  stats.cacheHits += 1;
}

export function getDecodeCacheStats() {
  return { ...stats };
}

export function resetDecodeCacheStats() {
  stats.ffmpegDecodes = 0;
  stats.cacheHits = 0;
}

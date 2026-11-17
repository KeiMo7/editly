import { ExecaError } from "execa";
import * as fabric from "fabric/node";
import fsExtra from "fs-extra";
import type { FileHandle } from "fs/promises";
import { open } from "fs/promises";
import { nanoid } from "nanoid";
import { defineFrameSource } from "../api/index.js";
import { resolveColorHandling } from "../color.js";
import {
  getDecodeCacheKey,
  getDecodeCachePaths,
  noteCacheHit,
  noteFfmpegDecode,
} from "../decodeCache.js";
import { ffmpeg, readFileStreams } from "../ffmpeg.js";
import { rawVideoToFrames } from "../transforms/rawVideoToFrames.js";
import type { VideoLayer } from "../types.js";
import { blurImage, rgbaToFabricImage } from "./fabric.js";

export default defineFrameSource<VideoLayer>("video", async (options) => {
  const {
    width: canvasWidth,
    height: canvasHeight,
    channels,
    framerateStr,
    verbose,
    logTimes,
    hdr,
    decodeCache,
    params,
  } = options;

  const {
    path,
    cutFrom,
    cutTo,
    resizeMode = "contain-blur",
    speedFactor,
    inputWidth,
    inputHeight,
    width: requestedWidthRel,
    height: requestedHeightRel,
    left: leftRel = 0,
    top: topRel = 0,
    originX = "left",
    originY = "top",
    fabricImagePostProcessing = null,
  } = params;

  const requestedWidth = requestedWidthRel
    ? Math.round(requestedWidthRel * canvasWidth)
    : canvasWidth;
  const requestedHeight = requestedHeightRel
    ? Math.round(requestedHeightRel * canvasHeight)
    : canvasHeight;

  const left = leftRel * canvasWidth;
  const top = topRel * canvasHeight;

  const ratioW = requestedWidth / inputWidth!;
  const ratioH = requestedHeight / inputHeight!;
  const inputAspectRatio = inputWidth! / inputHeight!;

  let targetWidth = requestedWidth;
  let targetHeight = requestedHeight;

  let scaleFilter;
  if (["contain", "contain-blur"].includes(resizeMode)) {
    if (ratioW > ratioH) {
      targetHeight = requestedHeight;
      targetWidth = Math.round(requestedHeight * inputAspectRatio);
    } else {
      targetWidth = requestedWidth;
      targetHeight = Math.round(requestedWidth / inputAspectRatio);
    }

    scaleFilter = `scale=${targetWidth}:${targetHeight}`;
  } else if (resizeMode === "cover") {
    let scaledWidth;
    let scaledHeight;

    if (ratioW > ratioH) {
      scaledWidth = requestedWidth;
      scaledHeight = Math.round(requestedWidth / inputAspectRatio);
    } else {
      scaledHeight = requestedHeight;
      scaledWidth = Math.round(requestedHeight * inputAspectRatio);
    }

    // TODO improve performance by crop first, then scale?
    scaleFilter = `scale=${scaledWidth}:${scaledHeight},crop=${targetWidth}:${targetHeight}`;
  } else {
    // 'stretch'
    scaleFilter = `scale=${targetWidth}:${targetHeight}`;
  }

  if (verbose) console.log(scaleFilter);

  let ptsFilter = "";
  if (speedFactor !== 1) {
    if (verbose) console.log("speedFactor", speedFactor);
    ptsFilter = `setpts=${speedFactor}*PTS,`;
  }

  // https://forum.unity.com/threads/settings-for-importing-a-video-with-an-alpha-channel.457657/
  const streams = await readFileStreams(path);
  const firstVideoStream = streams.find((s) => s.codec_type === "video");
  // https://superuser.com/a/1116905/658247

  let inputCodec;
  if (firstVideoStream?.codec_name === "vp8") inputCodec = "libvpx";
  else if (firstVideoStream?.codec_name === "vp9") inputCodec = "libvpx-vp9";

  // HDR: resolve how this input must be decoded (probed & classified once per
  // asset, cached). SDR inputs get no extra filters and behave exactly as before.
  const colorHandling = hdr?.enabled ? await resolveColorHandling(path, hdr) : undefined;
  const toneMapFilter = colorHandling?.toneMapFilter;

  // http://zulko.github.io/blog/2013/09/27/read-and-write-video-frames-in-python-using-ffmpeg/
  // Testing: ffmpeg -i 'vid.mov' -t 1 -vcodec rawvideo -pix_fmt rgba -f image2pipe - | ffmpeg -f rawvideo -vcodec rawvideo -pix_fmt rgba -s 2166x1650 -i - -vf format=yuv420p -vcodec libx264 -y out.mp4
  // https://trac.ffmpeg.org/wiki/ChangingFrameRate
  const args = [
    "-nostdin",
    ...(inputCodec ? ["-vcodec", inputCodec] : []),
    ...(cutFrom ? ["-ss", cutFrom.toString()] : []),
    "-i",
    path,
    ...(cutTo ? ["-t", ((cutTo - cutFrom!) * speedFactor!).toString()] : []),
    "-vf",
    `${ptsFilter}fps=${framerateStr},${scaleFilter}${toneMapFilter ? `,${toneMapFilter}` : ""}`,
    "-map",
    "v:0",
    "-vcodec",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-f",
    "image2pipe",
    "-",
  ];

  const frameByteSize = targetWidth * targetHeight * channels;

  // Decode-once cache: if this file is referenced multiple times, the first
  // decode stores the raw frames in tmpDir and later references stream them
  // from disk instead of decoding again.
  const decodeCacheKey =
    decodeCache && decodeCache.cacheablePaths.has(path)
      ? getDecodeCacheKey({
          path,
          cutFrom,
          cutTo,
          speedFactor,
          framerateStr,
          targetWidth,
          targetHeight,
          toneMapFilter,
        })
      : undefined;

  let cacheReadHandle: FileHandle | undefined;
  let cacheReadOffset = 0;
  let cacheReadPath: string | undefined;
  let waitForCacheBytes: ((byteCount: number) => Promise<boolean>) | undefined;
  let cacheDecodeFailed = false;
  let closed = false;

  const controller = new AbortController();

  // Wall-clock decode timing, so the cost of the HDR path vs the SDR path can
  // be measured (logTimes). The streaming decode is usually aborted at clip
  // end, so the timing is reported when the source is closed.
  let decodeStartedAt: number | undefined;
  const logDecodeTiming = (event: string) => {
    if (logTimes && decodeStartedAt != null) {
      console.log(
        `Decode ${event} for ${path} after ${Date.now() - decodeStartedAt}ms (color: ${colorHandling?.classification.kind ?? "sdr"}${toneMapFilter ? ", tone-mapped" : ""})`,
      );
      decodeStartedAt = undefined;
    }
  };

  if (decodeCacheKey && decodeCache) {
    const { frameFile, doneFile } = getDecodeCachePaths(decodeCache, decodeCacheKey);
    if (await fsExtra.pathExists(doneFile)) {
      noteCacheHit();
      if (verbose) console.log("Decode cache hit, streaming frames from cache:", path);
      cacheReadHandle = await open(frameFile, "r");
    } else {
      // Decode straight to a cache file. ffmpeg writes the file directly, so
      // the decode is not throttled by frame consumption and finishes as fast
      // as possible; frames are read back from the growing file. A unique tmp
      // name + atomic rename keeps this safe when two frame sources decode
      // the same asset concurrently (e.g. overlapping transition sources).
      const tmpFile = `${frameFile}.${nanoid()}.tmp`;
      cacheReadPath = tmpFile;
      let cacheDecodeDone = false;

      noteFfmpegDecode();
      decodeStartedAt = Date.now();
      const cacheArgs = [...args.slice(0, -3), "-f", "rawvideo", "-y", tmpFile];
      const cachePs = ffmpeg(cacheArgs, {
        encoding: "buffer",
        buffer: false,
        stdin: "ignore",
        stderr: process.stderr,
        // ffmpeg doesn't like to stop, force it
        forceKillAfterDelay: 1000,
        cancelSignal: controller.signal,
      });

      cachePs
        .then(async () => {
          logDecodeTiming("finished");
          await fsExtra.move(tmpFile, frameFile, { overwrite: true });
          cacheReadPath = frameFile;
          await fsExtra.writeFile(doneFile, "");
          cacheDecodeDone = true;
          if (verbose) console.log("Decode cache stored:", path);
        })
        .catch((err: ExecaError) => {
          cacheDecodeDone = true;
          if (!err.isCanceled) {
            cacheDecodeFailed = true;
            console.error(`Failed to decode video: ${path}`);
          }
          // Aborted or failed decode: never leave a partial cache file behind
          fsExtra.remove(tmpFile).catch(() => {});
        });

      waitForCacheBytes = async (byteCount: number) => {
        for (;;) {
          if (closed || cacheDecodeFailed) return false;
          let size = 0;
          try {
            size = (await fsExtra.stat(cacheReadPath!)).size;
          } catch {
            // File not created yet
          }
          if (size >= byteCount) return true;
          if (cacheDecodeDone) return false;
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
        }
      };
    }
  }

  let ps: ReturnType<typeof ffmpeg> | undefined;
  let iterator: AsyncIterableIterator<unknown> | undefined;

  if (!cacheReadHandle && !waitForCacheBytes) {
    noteFfmpegDecode();
    decodeStartedAt = Date.now();
    const transform = rawVideoToFrames({
      width: targetWidth,
      height: targetHeight,
      channels,
      signal: controller.signal,
    });
    ps = ffmpeg(args, {
      encoding: "buffer",
      buffer: false,
      stdin: "ignore",
      stdout: { transform },
      stderr: process.stderr,
      // ffmpeg doesn't like to stop, force it
      forceKillAfterDelay: 1000,
      cancelSignal: controller.signal,
    });

    const processDone = ps as unknown as Promise<unknown>;
    processDone
      .then(async () => {
        logDecodeTiming("finished");
      })
      .catch(() => {});

    // Ignore errors if the process is aborted
    ps.catch((err: ExecaError) => {
      if (!err.isCanceled) throw err;
      if (verbose) console.log("ffmpeg process aborted", path);
    });

    // Convert process to iterator to fetch frame data
    iterator = ps.iterable();
  }

  async function readNextFrame(progress: number, canvas: fabric.StaticCanvas, time: number) {
    let rgba: Uint8Array | undefined;

    if (cacheReadHandle || waitForCacheBytes) {
      if (waitForCacheBytes) {
        const ok = await waitForCacheBytes(cacheReadOffset + frameByteSize);
        if (!ok) {
          if (cacheDecodeFailed) throw new Error(`Failed to decode video (decode cache): ${path}`);
          if (verbose) console.log(path, "decode cache stream ended");
          return;
        }
      }
      if (!cacheReadHandle) {
        // Open lazily: the cache file is created by the decoder process
        cacheReadHandle = await open(cacheReadPath!, "r");
      }
      const buffer = Buffer.alloc(frameByteSize);
      const { bytesRead } = await cacheReadHandle.read(buffer, 0, frameByteSize, cacheReadOffset);
      if (bytesRead < frameByteSize) {
        if (verbose) console.log(path, "decode cache stream ended");
        return;
      }
      cacheReadOffset += bytesRead;
      rgba = buffer;
    } else {
      const { value, done } = await iterator!.next();

      if (done) {
        if (verbose) console.log(path, "ffmpeg video stream ended");
        return;
      }

      if (!value) {
        if (verbose) console.log(path, "No frame data received");
        return;
      }

      rgba = value as Uint8Array;
    }

    if (logTimes) console.time("rgbaToFabricImage");
    const img = await rgbaToFabricImage({
      width: targetWidth,
      height: targetHeight,
      rgba: Buffer.from(rgba),
    });
    if (logTimes) console.timeEnd("rgbaToFabricImage");

    img.set({
      originX,
      originY,
    });

    let centerOffsetX = 0;
    let centerOffsetY = 0;
    if (resizeMode === "contain" || resizeMode === "contain-blur") {
      const dirX = originX === "left" ? 1 : -1;
      const dirY = originY === "top" ? 1 : -1;
      centerOffsetX = (dirX * (requestedWidth - targetWidth)) / 2;
      centerOffsetY = (dirY * (requestedHeight - targetHeight)) / 2;
    }

    img.set({
      left: left + centerOffsetX,
      top: top + centerOffsetY,
    });

    if (resizeMode === "contain-blur") {
      const mutableImg = img.cloneAsImage({});
      const blurredImg = await blurImage({
        mutableImg,
        width: requestedWidth,
        height: requestedHeight,
      });
      blurredImg.set({
        left,
        top,
        originX,
        originY,
      });
      canvas.add(blurredImg);
    }

    if (fabricImagePostProcessing) {
      fabricImagePostProcessing({ image: img, progress, fabric, canvas, time });
    }

    canvas.add(img);
  }

  const close = () => {
    if (verbose) console.log("Close", path);
    closed = true;
    logDecodeTiming("stopped");
    if (ps && !ps.exitCode) controller.abort();
    cacheReadHandle?.close().catch(() => {});
  };

  return {
    readNextFrame,
    close,
  };
});

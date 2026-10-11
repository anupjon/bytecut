import type {
  EncoderName,
  VideoClipEncodeRequest,
  VideoEncodeRequest,
  VideoFramesRequest,
  VideoSampleRequest,
  VideoVmafRequest,
} from "./types.js";
import type { VideoProbe } from "./probe.js";

/** Largest even integer ≤ n (yuv420p needs even dimensions). */
export const evenDown = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

/** The width the output will have for a given source and cap; always even, never upscaled. */
export function outputWidth(sourceWidth: number, maxWidth: number | null): number {
  const capped = maxWidth !== null ? Math.min(sourceWidth, maxWidth) : sourceWidth;
  return evenDown(capped);
}

/** Frame-rate cap is applied only when the source exceeds it, so low-fps sources stay as-is. */
export function needsFpsCap(probe: Pick<VideoProbe, "fps">, maxFps: number | null): boolean {
  return maxFps !== null && probe.fps > maxFps + 0.01;
}

export function videoFilter(
  probe: Pick<VideoProbe, "width" | "fps">,
  maxWidth: number | null,
  maxFps: number | null,
): string {
  const filters: string[] = [];
  if (needsFpsCap(probe, maxFps)) filters.push(`fps=${maxFps}`);
  // -2 keeps the aspect ratio with an even height; the width is made even here.
  filters.push(`scale=${outputWidth(probe.width, maxWidth)}:-2:flags=lanczos`);
  filters.push("format=yuv420p");
  return filters.join(",");
}

export function encoderArgs(encoder: EncoderName, crf: number, speed: string): string[] {
  switch (encoder) {
    case "libsvtav1":
      return ["-c:v", "libsvtav1", "-crf", String(crf), "-preset", speed];
    case "libaom-av1":
      // libaom needs -b:v 0 for constant-quality mode.
      return [
        "-c:v",
        "libaom-av1",
        "-crf",
        String(crf),
        "-b:v",
        "0",
        "-cpu-used",
        speed,
        "-row-mt",
        "1",
      ];
    case "libx264":
      return ["-c:v", "libx264", "-crf", String(crf), "-preset", speed];
  }
}

/**
 * Arguments for the real output, never joined into a shell string (§6.14). The bitexact and
 * metadata flags keep output deterministic (§6.12): no creation time, no encoder-version
 * banner in the muxer that would vary between machines.
 */
export function buildEncodeArgs(request: VideoEncodeRequest): string[] {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-i",
    request.source,
    "-map",
    "0:v:0",
  ];
  if (request.audio === "keep" && request.probe.hasAudio) {
    args.push("-map", "0:a:0", "-c:a", "aac", "-b:a", request.audioBitrate);
  } else {
    args.push("-an");
  }
  args.push(
    "-vf",
    videoFilter(request.probe, request.maxWidth, request.maxFps),
    ...encoderArgs(request.encoder, request.crf, request.speed),
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    "-flags:a",
    "+bitexact",
    // The reserved temp path ends in .tmp, so the muxer cannot be inferred from it.
    "-f",
    "mp4",
    "-progress",
    "pipe:1",
    "-nostats",
    request.output,
  );
  return args;
}

/** A short clip encoded to a raw elementary stream on stdout: size only, no file written. */
export function buildSampleArgs(request: VideoSampleRequest): string[] {
  const raw = request.encoder === "libx264" ? "h264" : "ivf";
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-ss",
    String(request.startSec),
    "-t",
    String(request.durationSec),
    "-i",
    request.source,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    videoFilter(request.probe, request.maxWidth, request.maxFps),
    ...encoderArgs(request.encoder, request.crf, request.speed),
    "-f",
    raw,
    "pipe:1",
  ];
}

/**
 * A clip encoded to Matroska on stdout. Unlike the raw stream used for sizing, Matroska keeps
 * timestamps, so decoding it lines up with the reference frame for frame.
 */
export function buildClipEncodeArgs(request: VideoSampleRequest): string[] {
  const args = buildSampleArgs(request);
  const at = args.lastIndexOf("-f");
  return [...args.slice(0, at), "-f", "matroska", "pipe:1"];
}

const COMMON = ["-hide_banner", "-nostdin", "-loglevel", "error"];

/** Frames per clip at an even spacing, as raw RGB on stdout. */
function frameSelection(request: { count: number; durationSec: number }): string[] {
  // fps keeps the first frame of each interval; -frames:v bounds any rounding in the count.
  const rate = Math.max(0.1, request.count / Math.max(0.1, request.durationSec));
  return [`fps=${Math.round(rate * 1000) / 1000}`];
}

function rawOut(count: number): string[] {
  return ["-frames:v", String(count), "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"];
}

/** Decode frames of a file (the source or an output) to scaled raw RGB. */
export function buildFramesArgs(request: VideoFramesRequest): string[] {
  const filters: string[] = [];
  if (request.pipeline) {
    const { probe, maxWidth, maxFps } = request.pipeline;
    filters.push(videoFilter(probe, maxWidth, maxFps));
  }
  filters.push(...frameSelection(request), `scale=${request.width}:${request.height}:flags=area`);
  return [
    ...COMMON,
    "-ss",
    String(request.startSec),
    "-t",
    String(request.durationSec),
    "-i",
    request.source,
    "-map",
    "0:v:0",
    "-vf",
    filters.join(","),
    ...rawOut(request.count),
  ];
}

/** Decode a Matroska clip piped on stdin, with the same frame selection and geometry. */
export function buildPipedFramesArgs(request: VideoClipEncodeRequest): string[] {
  return [
    ...COMMON,
    "-f",
    "matroska",
    "-i",
    "pipe:0",
    "-map",
    "0:v:0",
    "-vf",
    [...frameSelection(request), `scale=${request.width}:${request.height}:flags=area`].join(","),
    ...rawOut(request.count),
  ];
}

/**
 * libvmaf over the source clip (reference) and the encoded clip piped on stdin (distorted),
 * both at the output's size. The score is the last "VMAF score:" line libvmaf logs.
 */
export function buildVmafArgs(request: VideoVmafRequest, width: number, height: number): string[] {
  const size = `scale=${width}:${height}:flags=bicubic,setpts=PTS-STARTPTS`;
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "info",
    "-ss",
    String(request.startSec),
    "-t",
    String(request.durationSec),
    "-i",
    request.source,
    ...(request.candidate
      ? [
          "-ss",
          String(request.startSec),
          "-t",
          String(request.durationSec),
          "-i",
          request.candidate,
        ]
      : ["-f", "matroska", "-i", "pipe:0"]),
    "-lavfi",
    `[0:v]${videoFilter(request.probe, request.maxWidth, request.maxFps)},${size}[ref];` +
      `[1:v]${size}[dist];[dist][ref]libvmaf=n_subsample=3`,
    "-f",
    "null",
    "-",
  ];
}

/** "VMAF score: 93.52" from ffmpeg's log, or null. */
export function parseVmafScore(stderr: string): number | null {
  const matches = [...stderr.matchAll(/VMAF score:\s*(-?\d+(?:\.\d+)?)/g)];
  const last = matches[matches.length - 1];
  return last ? Number(last[1]) : null;
}

export function buildFrameArgs(
  source: string,
  atSec: number,
  maxWidth: number | null,
  sourceWidth: number,
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-ss",
    String(atSec),
    "-i",
    source,
    "-frames:v",
    "1",
    "-vf",
    `scale=${outputWidth(sourceWidth, maxWidth)}:-2:flags=lanczos`,
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "pipe:1",
  ];
}

/** `out_time_us` (microseconds) from `-progress pipe:1` output, as a 0..1 fraction. */
export function progressFraction(chunk: string, durationSec: number): number | null {
  if (durationSec <= 0) return null;
  let latest: number | null = null;
  for (const line of chunk.split("\n")) {
    const m = /^out_time_us=(\d+)/.exec(line.trim());
    if (m) latest = Number(m[1]);
  }
  if (latest === null) return null;
  return Math.max(0, Math.min(1, latest / (durationSec * 1_000_000)));
}

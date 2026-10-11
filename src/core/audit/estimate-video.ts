import type { AnalysisCache } from "../cache/store.js";
import type { Capabilities } from "../ffmpeg/index.js";
import { pickAv1Encoder } from "../ffmpeg/index.js";
import type { PlannedVideoOutput, VideoPlanItem } from "../plan/types.js";
import type { VideoProbe } from "../video/probe.js";
import type { EncoderName, VideoEngine } from "../video/types.js";
import type { VideoEstimate } from "./estimate.js";

/** Whole clip is encoded exactly up to this length; longer videos are sampled. */
export const EXACT_MAX_SECONDS = 4;
export const SAMPLE_SECONDS = 1.5;
/** Where in the clip samples are taken, as fractions of the duration. */
export const SAMPLE_POINTS = [0.2, 0.5, 0.8] as const;

function encoderFor(codec: "av1" | "h264", caps: Capabilities): EncoderName | null {
  return codec === "h264" ? (caps.libx264 ? "libx264" : null) : pickAv1Encoder(caps);
}

const probeOf = (item: VideoPlanItem): VideoProbe => ({
  durationSec: item.durationSec,
  width: item.sourceWidth,
  height: item.sourceHeight,
  fps: item.fps,
  videoCodec: item.videoCodec,
  pixelFormat: null,
  bitrate: null,
  hasAudio: item.hasAudio,
  audioCodec: null,
  container: "unknown",
});

export function sampleStarts(durationSec: number): { startSec: number; durationSec: number }[] {
  if (durationSec <= EXACT_MAX_SECONDS) return [{ startSec: 0, durationSec }];
  return SAMPLE_POINTS.map((p) => ({
    startSec: Math.max(
      0,
      Math.min(durationSec - SAMPLE_SECONDS, durationSec * p - SAMPLE_SECONDS / 2),
    ),
    durationSec: SAMPLE_SECONDS,
  }));
}

/** Audio is not trial-encoded; its size follows directly from the bitrate. */
export function audioBytes(out: PlannedVideoOutput, item: VideoPlanItem): number {
  if (out.audio !== "keep" || !item.hasAudio) return 0;
  const kbps = Number(out.audioBitrate.replace(/k$/, ""));
  return Math.round((kbps * 1000 * item.durationSec) / 8);
}

/**
 * Real encodes of short clips, scaled to the whole duration, cached by content hash + the
 * output's parameters + the ffmpeg version. A clip of at most four seconds is encoded whole
 * and so is exact. Returns null when no encoder is installed. Never writes a file.
 */
export async function estimateVideo(
  item: VideoPlanItem,
  deps: {
    engine: VideoEngine;
    cache: AnalysisCache;
    ffmpegVersion: string;
    signal?: AbortSignal | undefined;
    /** Called after each sample encode, so a slow estimate can show that it is working. */
    onStep?: ((step: { done: number; total: number }) => void) | undefined;
  },
  sourcePath: string,
): Promise<VideoEstimate | null> {
  if (item.skip) return null;
  const caps = await deps.engine.capabilities();
  if (!caps) return null;

  const probe = probeOf(item);
  const starts = sampleStarts(item.durationSec);
  const exact = starts.length === 1 && starts[0]!.durationSec >= item.durationSec;
  const perCodec: VideoEstimate["perCodec"] = [];
  const stepTotal =
    item.outputs.filter((o) => o.role === "video" && encoderFor(o.codec, caps)).length *
    starts.length;
  let stepsDone = 0;

  for (const out of item.outputs) {
    if (out.role !== "video") continue;
    const encoder = encoderFor(out.codec, caps);
    if (!encoder) continue;

    const key = [
      "video",
      item.sourceSha256,
      out.codec,
      encoder,
      out.crf,
      out.speed,
      out.maxWidth ?? "-",
      out.maxFps ?? "-",
      deps.ffmpegVersion,
      exact ? "exact" : "sampled",
    ].join("|");

    let streamBytes = deps.cache.getEstimate(key)?.bytes;
    if (streamBytes === undefined) {
      let total = 0;
      let seconds = 0;
      for (const s of starts) {
        total += await deps.engine.sampleBytes(
          {
            source: sourcePath,
            encoder,
            crf: out.crf,
            speed: out.speed,
            maxWidth: out.maxWidth,
            maxFps: out.maxFps,
            startSec: s.startSec,
            durationSec: s.durationSec,
            probe,
          },
          deps.signal,
        );
        deps.onStep?.({ done: ++stepsDone, total: stepTotal });
        seconds += s.durationSec;
      }
      streamBytes = Math.round(seconds > 0 ? (total / seconds) * item.durationSec : total);
      deps.cache.setEstimate(key, { bytes: streamBytes, basis: exact ? "exact" : "extrapolated" });
    }
    const total = streamBytes + audioBytes(out, item);
    perCodec.push({
      codec: out.codec,
      // A size cap is met by raising the CRF or narrowing the width, or the output is not
      // written at all, so what a run will produce never exceeds it.
      bytes: out.search?.maxBytes !== undefined ? Math.min(total, out.search.maxBytes) : total,
      basis: exact ? "exact" : "extrapolated",
    });
  }

  if (perCodec.length === 0) return null;
  const best = perCodec.reduce((a, b) => (b.bytes < a.bytes ? b : a));
  return { best, perCodec };
}

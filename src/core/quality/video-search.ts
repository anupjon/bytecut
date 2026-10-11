import { outputWidth } from "../video/args.js";
import type { VideoProbe } from "../video/probe.js";
import type { EncoderName, VideoClip, VideoCodec, VideoEngine } from "../video/types.js";
import type { QualityScorer, RgbImage } from "./types.js";

const evenDown = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** Sampled clips: three windows of two seconds, or the whole video when it is short. */
export const CLIP_SECONDS = 2;
export const WHOLE_MAX_SECONDS = 6;
export const CLIP_POINTS = [0.2, 0.5, 0.8] as const;
/** Frames scored per clip. */
export const FRAMES_PER_CLIP = 4;
/** Frames are scored at most this wide, like the image tile. */
export const SCORE_WIDTH = 512;
/** Encoders reject or waste effort outside these; the search never leaves them. */
export const CRF_RANGE: Record<VideoCodec, { lo: number; hi: number }> = {
  av1: { lo: 10, hi: 63 },
  h264: { lo: 10, hi: 51 },
};
/** A full-length encode that falls short of the sampled score is retried this many times. */
export const MAX_CONFIRM_BUMPS = 3;
export const CONFIRM_STEP = 2;
/**
 * Each width step is 20% narrower: a candidate costs a search and a full encode, so video
 * steps further than images do (1920 → 1536 → 1228 → 982 before half is reached).
 */
export const WIDTH_STEP = 0.8;
/** A picture less than half as wide is no longer the one that was asked for. */
export const MIN_WIDTH_FRACTION = 0.5;

/** The next width to try after `width`, or null when stepping down has reached half. */
export function stepWidth(plannedWidth: number, width: number): number | null {
  const next = evenDown(width * WIDTH_STEP);
  const half = Math.ceil(plannedWidth * MIN_WIDTH_FRACTION);
  return next < half || next >= width ? null : next;
}

export function clipsFor(durationSec: number): { clips: VideoClip[]; whole: boolean } {
  if (durationSec <= WHOLE_MAX_SECONDS) {
    return { clips: [{ startSec: 0, durationSec }], whole: true };
  }
  const clips = CLIP_POINTS.map((p) => ({
    startSec:
      Math.round(
        Math.max(0, Math.min(durationSec - CLIP_SECONDS, durationSec * p - CLIP_SECONDS / 2)) *
          1000,
      ) / 1000,
    durationSec: CLIP_SECONDS,
  }));
  return { clips, whole: false };
}

/** The size every scored frame is brought to: at most 512 wide, the output's aspect ratio. */
export function scoreGeometry(
  probe: Pick<VideoProbe, "width" | "height">,
  maxWidth: number | null,
): { width: number; height: number } {
  const out = outputWidth(probe.width, maxWidth);
  const width = evenDown(Math.min(SCORE_WIDTH, out));
  const height = evenDown((probe.height * width) / Math.max(1, probe.width));
  return { width, height };
}

export type CrfOutcome =
  | { ok: true; crf: number; score: number; probes: number }
  | { ok: false; bestScore: number; probes: number };

/**
 * The highest CRF (smallest file) whose score meets `target`. Starts at the preset's own CRF,
 * which usually lands within a few steps, and bisects between a CRF known to pass and one
 * known to fail. A passing CRF is always one that was measured, so a non-monotonic encoder
 * can cost bytes but never returns a CRF that missed the target.
 */
export async function findCrf(options: {
  start: number;
  lo: number;
  hi: number;
  target: number;
  measure(crf: number): Promise<number>;
}): Promise<CrfOutcome> {
  const { lo, hi, target } = options;
  const scores = new Map<number, number>();
  const measure = async (crf: number) => {
    const known = scores.get(crf);
    if (known !== undefined) return known;
    const score = await options.measure(crf);
    scores.set(crf, score);
    return score;
  };
  const passes = async (crf: number) => (await measure(crf)) >= target;
  const start = Math.min(hi, Math.max(lo, options.start));

  let good: number;
  let bad: number;
  if (await passes(start)) {
    good = start;
    bad = hi + 1;
    if (start < hi) {
      if (await passes(hi)) good = hi;
      else bad = hi;
    }
  } else {
    bad = start;
    if (start === lo || !(await passes(lo))) {
      return { ok: false, bestScore: scores.get(lo) ?? scores.get(start)!, probes: scores.size };
    }
    good = lo;
  }
  while (bad - good > 1) {
    const mid = Math.floor((good + bad) / 2);
    if (await passes(mid)) good = mid;
    else bad = mid;
  }
  return { ok: true, crf: good, score: scores.get(good)!, probes: scores.size };
}

export type FitOutcome =
  { ok: true; crf: number; bytes: number } | { ok: false; bytes: number; crf: number };

/**
 * The lowest CRF in [lo, hi] whose predicted size fits `maxBytes`. Size only ever falls as the
 * CRF rises, so this bisects; `lo` is where quality is best, so the first CRF that fits is the
 * best quality that fits. Not ok when even `hi` is too big, with that size.
 */
export async function fitCrfToSize(options: {
  lo: number;
  hi: number;
  maxBytes: number;
  sizeAt(crf: number): Promise<number>;
}): Promise<FitOutcome> {
  const sizes = new Map<number, number>();
  const size = async (crf: number) => {
    const known = sizes.get(crf);
    if (known !== undefined) return known;
    const bytes = await options.sizeAt(crf);
    sizes.set(crf, bytes);
    return bytes;
  };
  const first = await size(options.lo);
  if (first <= options.maxBytes) return { ok: true, crf: options.lo, bytes: first };
  const last = await size(options.hi);
  if (last > options.maxBytes) return { ok: false, crf: options.hi, bytes: last };
  let bad = options.lo;
  let good = options.hi;
  while (good - bad > 1) {
    const mid = Math.floor((bad + good) / 2);
    if ((await size(mid)) <= options.maxBytes) good = mid;
    else bad = mid;
  }
  return { ok: true, crf: good, bytes: sizes.get(good)! };
}

export interface VideoSearchRequest {
  engine: VideoEngine;
  metric: "ssimulacra2" | "vmaf";
  target: number;
  /** Required for ssimulacra2. */
  scorer?: QualityScorer | undefined;
  /** Absolute path of the source. */
  source: string;
  probe: VideoProbe;
  codec: VideoCodec;
  encoder: EncoderName;
  speed: string;
  maxWidth: number | null;
  maxFps: number | null;
  startCrf: number;
  signal?: AbortSignal | undefined;
  /** Called after each measured CRF. */
  onProbe?: ((crf: number, score: number) => void) | undefined;
}

export interface VideoSearcher {
  /** Whole-video searches are exact: the confirmation would repeat the same encode. */
  readonly whole: boolean;
  find(): Promise<CrfOutcome>;
  /** The worst clip's score at `crf`, same metric as `find`. */
  score(crf: number): Promise<number>;
  /**
   * Predicted video-stream bytes of the whole output at `crf`: the sampled clips' bytes per
   * second over the full duration (exact when the whole video is the sample).
   */
  sizeAt(crf: number): Promise<number>;
  /** Score a finished output over the same clips, with the same metric. */
  confirm(outputPath: string, crf: number): Promise<number>;
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Perceptual CRF search for one video output. The score of a CRF is the WORST sampled clip's
 * (mean over its frames): one hard scene decides, because that is where a viewer notices.
 */
export function createVideoSearcher(request: VideoSearchRequest): VideoSearcher {
  const { clips, whole } = clipsFor(request.probe.durationSec);
  const { width, height } = scoreGeometry(request.probe, request.maxWidth);
  const references = new Map<number, Promise<RgbImage[]>>();

  const reference = (index: number) => {
    let cached = references.get(index);
    if (!cached) {
      const clip = clips[index]!;
      cached = request.engine.frames(
        {
          ...clip,
          source: request.source,
          count: FRAMES_PER_CLIP,
          width,
          height,
          pipeline: { probe: request.probe, maxWidth: request.maxWidth, maxFps: request.maxFps },
        },
        request.signal,
      );
      references.set(index, cached);
    }
    return cached;
  };

  async function scoreFrames(ref: RgbImage[], got: RgbImage[]): Promise<number> {
    const n = Math.min(ref.length, got.length);
    // fps selection can differ by one frame at a clip edge; more than that is a real mismatch.
    if (n === 0 || Math.abs(ref.length - got.length) > 1) {
      throw new Error(`compared ${ref.length} reference and ${got.length} encoded frames`);
    }
    const scorer = request.scorer;
    if (!scorer) throw new Error("ssimulacra2 needs a scorer");
    const scores: number[] = [];
    for (let i = 0; i < n; i++) scores.push(await scorer.score(ref[i]!, got[i]!));
    return mean(scores);
  }

  const sample = (clip: VideoClip, crf: number) => ({
    source: request.source,
    encoder: request.encoder,
    crf,
    speed: request.speed,
    maxWidth: request.maxWidth,
    maxFps: request.maxFps,
    ...clip,
    probe: request.probe,
  });

  // The clips are independent, so they run side by side: a small clip does not keep every
  // core busy on its own, and a large one is bounded by the encoder's own threads anyway.
  async function measure(crf: number): Promise<number> {
    const perClip = await Promise.all(
      clips.map(async (clip, i) => {
        if (request.metric === "vmaf") {
          return request.engine.vmaf(sample(clip, crf), request.signal);
        }
        const got = await request.engine.encodedFrames(
          { ...sample(clip, crf), count: FRAMES_PER_CLIP, width, height },
          request.signal,
        );
        return scoreFrames(await reference(i), got);
      }),
    );
    const score = Math.min(...perClip);
    request.onProbe?.(crf, score);
    return score;
  }

  async function sizeAt(crf: number): Promise<number> {
    const bytes = await Promise.all(
      clips.map((clip) => request.engine.sampleBytes(sample(clip, crf), request.signal)),
    );
    const total = bytes.reduce((a, b) => a + b, 0);
    const seconds = clips.reduce((a, c) => a + c.durationSec, 0);
    return Math.round(
      whole ? total : (total / Math.max(0.001, seconds)) * request.probe.durationSec,
    );
  }

  return {
    whole,
    score: measure,
    sizeAt,
    async find() {
      const range = CRF_RANGE[request.codec];
      return findCrf({
        start: request.startCrf,
        lo: range.lo,
        hi: range.hi,
        target: request.target,
        measure,
      });
    },
    async confirm(outputPath, crf) {
      const perClip = await Promise.all(
        clips.map(async (clip, i) => {
          if (request.metric === "vmaf") {
            return request.engine.vmaf(
              { ...sample(clip, crf), candidate: outputPath },
              request.signal,
            );
          }
          const got = await request.engine.frames(
            { ...clip, source: outputPath, count: FRAMES_PER_CLIP, width, height, pipeline: null },
            request.signal,
          );
          return scoreFrames(await reference(i), got);
        }),
      );
      return Math.min(...perClip);
    },
  };
}

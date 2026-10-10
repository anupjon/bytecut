import type { ItemEstimate } from "../src/core/audit/estimate.js";
import type { AuditContext, ImageFacts, SvgFacts, VideoFacts } from "../src/core/audit/types.js";
import type { VideoPlanItem } from "../src/core/plan/types.js";
import type { VideoProbe } from "../src/core/video/probe.js";
import type { ImageAnalysis } from "../src/core/engines/types.js";
import type { PlanItem } from "../src/core/plan/types.js";
import { fakeAnalysis } from "./helpers.js";

export function estimate(bytes: number, width = 1920): ItemEstimate {
  const best = { format: "avif" as const, width, bytes, basis: "extrapolated" as const };
  return { best, perFormat: [best] };
}

const planItem = (source: string, bytes: number, widths: number[]): PlanItem => ({
  source,
  sourceBytes: bytes,
  sourceSha256: "a".repeat(64),
  sourceWidth: 2000,
  sourceHeight: 1000,
  preset: "photo",
  outputs: widths.map((width) => ({
    path: `${source}-${width}.avif`,
    format: "avif" as const,
    width,
    lossless: false,
    quality: 60,
    effort: 4,
  })),
});

/** A not-yet-optimized photographic JPEG whose best output is estimated at a tenth. */
export function image(
  over: Partial<Omit<ImageFacts, "analysis">> & { analysis?: Partial<ImageAnalysis> } = {},
): ImageFacts {
  const { analysis, ...rest } = over;
  const source = rest.source ?? "img/a.jpg";
  const bytes = rest.bytes ?? 100_000;
  return {
    source,
    bytes,
    sha256: source
      .padEnd(64, "0")
      .slice(0, 64)
      .replace(/[^0-9a-f]/g, "0"),
    analysis: fakeAnalysis(analysis),
    classification: { preset: "photo", confidence: "high", reason: "test" },
    item: planItem(source, bytes, [640, 1280, 1920]),
    cache: { kind: "miss", reason: "new" },
    estimate: estimate(Math.round(bytes / 10)),
    ...rest,
  };
}

export function svg(over: Partial<SvgFacts> = {}): SvgFacts {
  return {
    source: "icons/a.svg",
    bytes: 10_000,
    sha256: "b".repeat(64),
    minifiedBytes: 4_000,
    embeddedRasterBytes: 0,
    embeddedRasterCount: 0,
    ...over,
  };
}

export function context(
  over: Partial<AuditContext> & { opts?: Record<string, Record<string, unknown>> } = {},
): AuditContext {
  const { opts = {}, ...rest } = over;
  return {
    plan: { version: 1, outDir: "out", publicPath: "/_bytecut", items: [] },
    manifest: null,
    encoders: { avif: "libaom-av1 3.15.1", webp: "libwebp 1.6.0" },
    sourceExists: async () => true,
    outputHash: async () => null,
    images: [],
    skipped: [],
    svgs: [],
    videos: [],
    unprobed: [],
    references: null,
    budgets: {},
    ffmpeg: { found: true, installHint: "sudo apt install ffmpeg" },
    options: (id) => opts[id] ?? {},
    ...rest,
  };
}

export function videoProbe(over: Partial<VideoProbe> = {}): VideoProbe {
  return {
    durationSec: 10,
    width: 1280,
    height: 720,
    fps: 30,
    videoCodec: "h264",
    pixelFormat: "yuv420p",
    bitrate: 1_000_000,
    hasAudio: true,
    audioCodec: "aac",
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    ...over,
  };
}

/** A not-yet-optimized H.264 MP4 with audio whose best output is estimated at a fifth. */
export function video(
  over: Partial<Omit<VideoFacts, "probe">> & { probe?: Partial<VideoProbe> } = {},
): VideoFacts {
  const { probe, ...rest } = over;
  const source = rest.source ?? "media/a.mp4";
  const bytes = rest.bytes ?? 1_000_000;
  const p = videoProbe(probe);
  const item: VideoPlanItem = {
    source,
    sourceBytes: bytes,
    sourceSha256: "c".repeat(64),
    sourceWidth: p.width,
    sourceHeight: p.height,
    durationSec: p.durationSec,
    fps: p.fps,
    hasAudio: p.hasAudio,
    videoCodec: p.videoCodec,
    preset: "content-video",
    outputs: [],
  };
  return {
    source,
    bytes,
    sha256: source
      .padEnd(64, "0")
      .slice(0, 64)
      .replace(/[^0-9a-f]/g, "0"),
    probe: p,
    faststart: true,
    classification: { preset: "content-video", confidence: "high", reason: "test" },
    item,
    cache: { kind: "miss", reason: "new" },
    estimate: {
      best: { codec: "av1", bytes: Math.round(bytes / 5), basis: "extrapolated" },
      perCodec: [{ codec: "av1", bytes: Math.round(bytes / 5), basis: "extrapolated" }],
    },
    hasPoster: false,
    isGif: false,
    ...rest,
  };
}

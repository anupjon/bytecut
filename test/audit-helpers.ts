import type { ItemEstimate } from "../src/core/audit/estimate.js";
import type { AuditContext, ImageFacts, SvgFacts } from "../src/core/audit/types.js";
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
    references: null,
    budgets: {},
    ffmpeg: { found: true, installHint: "sudo apt install ffmpeg" },
    options: (id) => opts[id] ?? {},
    ...rest,
  };
}

import type { AnalysisCache } from "../cache/store.js";
import type { ImageEngine } from "../engines/types.js";
import type { PlanItem, PlannedOutput } from "../plan/types.js";
import type { ImageFormat } from "../presets/photo.js";

/** Widest trial encode. Larger planned widths are extrapolated from it. */
export const TRIAL_MAX_WIDTH = 640;

/**
 * Encoded bytes grow roughly as width^1.6 for photographs downscaled from larger sources
 * (less than width², since downscaling packs more detail into each pixel). A prior, not a
 * law: on the fixtures the implied exponent ranged from 1.46 to 1.82, and a per-image fit
 * was worse than this constant, so estimates carry a `basis` and are advertised as such.
 */
export const SIZE_EXPONENT = 1.6;

export interface FormatEstimate {
  format: ImageFormat;
  /** Largest planned width for this format; the estimate is for that output. */
  width: number;
  bytes: number;
  basis: "exact" | "extrapolated";
}

export interface ItemEstimate {
  /** The smallest of the per-format estimates: what you'd serve at the largest width. */
  best: FormatEstimate;
  perFormat: FormatEstimate[];
}

export function estimateKey(
  sha256: string,
  preset: string,
  out: PlannedOutput,
  width: number,
  encoder: string,
): string {
  return [
    sha256,
    preset,
    out.format,
    width,
    out.lossless ? "L" : `q${out.quality}`,
    out.effort,
    encoder,
  ].join("|");
}

/**
 * Real encode at a small width, cached by content hash + preset parameters + encoder
 * version, scaled by pixel count to the largest planned width. Never writes outputs.
 */
export async function estimateItem(
  item: PlanItem,
  /** Only read when a trial encode is actually needed (cache miss). */
  readData: () => Promise<Buffer>,
  deps: { engine: ImageEngine; cache: AnalysisCache },
): Promise<ItemEstimate | null> {
  if (item.skip || item.outputs.length === 0) return null;
  const encoders = deps.engine.encoders();
  const perFormat: FormatEstimate[] = [];

  const formats = [...new Set(item.outputs.map((o) => o.format))];
  for (const format of formats) {
    const outs = item.outputs.filter((o) => o.format === format).sort((a, b) => a.width - b.width);
    const largest = outs[outs.length - 1]!;
    // Prefer the biggest planned width within the trial limit; if even the smallest planned
    // output is wider than that, trial at the smallest (the only way to stay cheap).
    const within = outs.filter((o) => o.width <= TRIAL_MAX_WIDTH);
    const trial = within.length > 0 ? within[within.length - 1]! : outs[0]!;

    const key = estimateKey(item.sourceSha256, item.preset, trial, trial.width, encoders[format]);
    let bytes = deps.cache.getEstimate(key)?.bytes;
    if (bytes === undefined) {
      const encoded = await deps.engine.encode(await readData(), trial);
      bytes = encoded.data.byteLength;
      deps.cache.setEstimate(key, { bytes, basis: "exact" });
    }

    const exact = trial.width === largest.width;
    perFormat.push({
      format,
      width: largest.width,
      bytes: exact ? bytes : Math.round(bytes * (largest.width / trial.width) ** SIZE_EXPONENT),
      basis: exact ? "exact" : "extrapolated",
    });
  }

  const best = perFormat.reduce((a, b) => (b.bytes < a.bytes ? b : a));
  return { best, perFormat };
}

/** Estimated size of the best (smallest) video output; same idea as `ItemEstimate`. */
export interface VideoEstimate {
  best: { codec: "av1" | "h264"; bytes: number; basis: "exact" | "extrapolated" };
  perCodec: Array<{ codec: "av1" | "h264"; bytes: number; basis: "exact" | "extrapolated" }>;
}

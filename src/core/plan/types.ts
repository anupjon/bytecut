import type { ImageFormat, QualitySearch } from "../presets/photo.js";
import type { VideoCodec } from "../video/types.js";

export interface PlannedOutput {
  /** POSIX path relative to `Plan.outDir`. */
  path: string;
  format: ImageFormat;
  width: number;
  lossless: boolean;
  quality: number;
  effort: number;
  /**
   * Perceptual target: the executor searches for the quality (and, to fit `maxBytes`, may
   * step the width down), so `quality` above is only the preset's fixed value. Never set
   * for lossless outputs, which are exact.
   */
  search?: QualitySearch;
}

export interface PlanItem {
  /** POSIX path relative to the project root. */
  source: string;
  sourceBytes: number;
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  /** Preset name, or "-" for items that are listed but skipped. */
  preset: string;
  /** Why the preset was chosen (absent when forced or skipped). */
  classification?: { reason: string; confidence?: "high" | "medium" | "low" };
  outputs: PlannedOutput[];
  /** Set when the file is listed but won't be processed. */
  skip?: { reason: string };
}

export interface PlannedVideoOutput {
  role: "video";
  /** POSIX path relative to `Plan.outDir`. */
  path: string;
  codec: VideoCodec;
  /** Output width after the cap, even. */
  width: number;
  crf: number;
  /** SVT-AV1 `-preset` number or x264 preset name. */
  speed: string;
  maxWidth: number | null;
  maxFps: number | null;
  audio: "strip" | "keep";
  audioBitrate: string;
  /** Find the CRF by perceptual search; `crf` is then the starting point and the fallback. */
  search?: { metric: "ssimulacra2" | "vmaf"; target: number };
}

export interface PlannedPosterOutput {
  role: "poster";
  path: string;
  format: "avif";
  width: number;
  quality: number;
  effort: number;
  /** Frame position as a fraction of the duration. */
  at: number;
}

export type PlannedMediaOutput = PlannedVideoOutput | PlannedPosterOutput;

/**
 * A video (or animated GIF) source. Kept apart from image items so image code is untouched.
 * The plan does not depend on which encoders are installed: availability is resolved when the
 * plan runs and reported then, so a saved plan means the same thing on any machine.
 */
export interface VideoPlanItem {
  source: string;
  sourceBytes: number;
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  durationSec: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  /** Preset name, or "-" for items that are listed but skipped. */
  preset: string;
  classification?: { reason: string; confidence?: "high" | "medium" | "low" };
  outputs: PlannedMediaOutput[];
  skip?: { reason: string };
}

/** Plain JSON-serializable data: everything the executor does is described here (§3). */
export interface Plan {
  version: 1;
  /** POSIX path relative to the project root. */
  outDir: string;
  /** URL prefix the manifest uses to build output URLs. */
  publicPath: string;
  items: PlanItem[];
  /** Present only when there are videos; image-only plans are unchanged. */
  videos?: VideoPlanItem[];
}

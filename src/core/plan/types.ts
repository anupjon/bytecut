import type { ImageFormat } from "../presets/photo.js";

export interface PlannedOutput {
  /** POSIX path relative to `Plan.outDir`. */
  path: string;
  format: ImageFormat;
  width: number;
  lossless: boolean;
  quality: number;
  effort: number;
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

/** Plain JSON-serializable data: everything the executor does is described here (§3). */
export interface Plan {
  version: 1;
  /** POSIX path relative to the project root. */
  outDir: string;
  /** URL prefix the manifest uses to build output URLs. */
  publicPath: string;
  items: PlanItem[];
}

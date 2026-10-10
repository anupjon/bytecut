import type { ImageFormat } from "../presets/photo.js";

export const MANIFEST_FILE = "bytecut-manifest.json";
/**
 * 2: output paths are mirrored relative to the static root (`public/img/a.jpg` →
 * `img/a/…`), not the project root. Version 1 was a pre-release layout.
 */
export const MANIFEST_VERSION = 2;

/**
 * `written`: file exists in outDir with `sha256`.
 * `already-optimal`: encoded but not written because it wasn't smaller than the source.
 * `stale`: file exists but no longer matches the current source (a run didn't complete).
 */
export type ManifestOutputStatus = "written" | "already-optimal" | "stale";

export interface ManifestOutput {
  /** POSIX path relative to outDir. */
  path: string;
  url: string;
  format: ImageFormat;
  width: number;
  height: number;
  bytes: number;
  /** Absent for `already-optimal`, which has no file. */
  sha256?: string;
  lossless: boolean;
  quality: number;
  effort: number;
  /** Encoder actually used, with version. */
  encoder: string;
  status: ManifestOutputStatus;
}

export interface ManifestSource {
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  preset: string;
  /**
   * Every output bytecut owns for this source. Entries the current plan no longer produces
   * are orphans, and are only deletable because they are listed here (§6.3).
   */
  outputs: ManifestOutput[];
}

/** No timestamps: the manifest is committed, so an unchanged run must leave it byte-identical. */
export interface Manifest {
  version: typeof MANIFEST_VERSION;
  /** Informational: versions of the tool that last wrote the manifest. */
  tools: Record<string, string>;
  publicPath: string;
  /** Keyed by POSIX path relative to the project root. */
  sources: Record<string, ManifestSource>;
}

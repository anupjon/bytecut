import type { Placeholder } from "../placeholders/types.js";
import type { ImageFormat } from "../presets/photo.js";

export const MANIFEST_FILE = "bytecut-manifest.json";
/**
 * 3: adds `videos`. Every version-2 manifest is a valid version-3 one with no videos, so v2 is
 * read and upgraded in memory.
 * 2: output paths are mirrored relative to the static root (`public/img/a.jpg` →
 * `img/a/…`), not the project root. Version 1 was a pre-release layout.
 */
export const MANIFEST_VERSION = 3;
/** Oldest version that is still read (and rewritten as the current one). */
export const MANIFEST_MIN_VERSION = 2;

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
  /** Present when the quality was found by a perceptual search. */
  search?: ManifestSearch;
  /** SSIMULACRA2 of this file against its source at this width, as the search measured it. */
  score?: number;
  /** Which scorer measured it. Informational: it is not part of cache validity. */
  scorer?: "wasm" | "native";
}

/** The parameters a searched output was made with; they, not `quality`, decide cache validity. */
export interface ManifestSearch {
  metric: "ssimulacra2";
  target: number;
  floor?: number;
  maxBytes?: number;
  /**
   * The path the plan listed when the width was stepped down to fit `maxBytes`, so the
   * output is still recognised as the one the plan asks for.
   */
  plannedPath?: string;
}

export interface ManifestSource {
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  preset: string;
  /** Show this image with `fetchpriority="high"` and no lazy loading (the LCP candidate). */
  priority?: boolean;
  /** A tiny stand-in while the image loads, made from the source. */
  placeholder?: Placeholder;
  /**
   * Every output bytecut owns for this source. Entries the current plan no longer produces
   * are orphans, and are only deletable because they are listed here (§6.3).
   */
  outputs: ManifestOutput[];
}

export interface ManifestVideoOutput {
  path: string;
  url: string;
  role: "video" | "poster";
  format: "mp4" | "avif";
  codec?: "av1" | "h264";
  width: number;
  height: number;
  fps?: number;
  bytes: number;
  sha256?: string;
  /** Resolved parameters, so "same source + same preset" can be decided from the manifest alone. */
  crf?: number;
  speed?: string;
  maxWidth?: number | null;
  maxFps?: number | null;
  audio?: "strip" | "keep";
  quality?: number;
  effort?: number;
  at?: number;
  /**
   * RFC 6381 codecs for `<source type>`, e.g. `av01.0.08M.08` or `avc1.640028, mp4a.40.2`.
   * Read from the file's own boxes; absent in manifests written before M6.
   */
  codecs?: string;
  /** Encoder actually used, with the ffmpeg version. */
  encoder: string;
  status: ManifestOutputStatus;
  /** Present when the CRF was found by a perceptual search; these, not `crf`, decide the cache. */
  search?: { metric: "ssimulacra2" | "vmaf"; target: number };
  /** The worst sampled clip's score for this output, as the search measured it. */
  score?: number;
  /** Which implementation measured it: `libvmaf` is ffmpeg's own filter. */
  scorer?: "wasm" | "native" | "libvmaf";
}

export interface ManifestVideoSource {
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  durationSec: number;
  preset: string;
  /** Whether the video preset is a loop/background (no controls) is derived from `preset`. */
  priority?: boolean;
  /** Made from the poster frame. */
  placeholder?: Placeholder;
  outputs: ManifestVideoOutput[];
}

/** No timestamps: the manifest is committed, so an unchanged run must leave it byte-identical. */
export interface Manifest {
  version: typeof MANIFEST_VERSION;
  /** Informational: versions of the tool that last wrote the manifest. */
  tools: Record<string, string>;
  publicPath: string;
  /** Keyed by POSIX path relative to the project root. */
  sources: Record<string, ManifestSource>;
  /** Videos and animated GIFs, keyed the same way. */
  videos: Record<string, ManifestVideoSource>;
}

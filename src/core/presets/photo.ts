/**
 * `jpg` is the default and the compatible fallback. `png` is lossless and is what a source with
 * real transparency (or an icon) gets in place of `jpg`, which has no alpha channel.
 */
export type ImageFormat = "jpg" | "png" | "webp" | "avif";

export interface ImagePreset {
  name: string;
  /**
   * Output widths, each never above the source. Ignored when `maxEdge` is set: that is the
   * default, and it makes one output per format.
   */
  widths: number[];
  /**
   * Cap on the LONGEST side: the width of a landscape image, the height of a portrait one,
   * with the other side in proportion. One output per format, never upscaled.
   */
  maxEdge?: number;
  formats: ImageFormat[];
  encoders: Record<ImageFormat, { quality: number; effort: number }>;
  /**
   * Force lossless for every format. When unset, only PNG→WebP is lossless (§6.8: a PNG's
   * content is ambiguous, and lossless AVIF is slow and rarely wins).
   */
  lossless?: boolean;
  /**
   * Images using this preset are likely the largest contentful paint: snippets mark them
   * `fetchpriority="high"` and never lazy-load them.
   */
  priority?: boolean;
  /**
   * A perceptual target. When set, lossy outputs search for the smallest quality that still
   * scores `target` (SSIMULACRA2), instead of using `encoders[format].quality` as is.
   */
  search?: QualitySearch;
}

/** Perceptual quality target for the search; `floor` and `maxBytes` come as a pair. */
export interface QualitySearch {
  metric: "ssimulacra2";
  /** Smallest acceptable score (100 is identical). */
  target: number;
  /** Lowest score the search may accept to fit `maxBytes`. */
  floor?: number;
  /** Largest allowed size of one output file. */
  maxBytes?: number;
}

/** Settings for formats a preset does not emit by default; used if a config adds them. */
export const OTHER_ENCODERS = {
  // PNG has no quality; `effort` is libpng's/oxipng-style effort (1–10).
  png: { quality: 100, effort: 7 },
} as const;

export const PHOTO_PRESET: ImagePreset = {
  name: "photo",
  widths: [],
  maxEdge: 1920,
  formats: ["jpg"],
  encoders: {
    ...OTHER_ENCODERS,
    jpg: { quality: 80, effort: 0 },
    avif: { quality: 60, effort: 4 },
    webp: { quality: 78, effort: 4 },
  },
};

export type ImageFormat = "avif" | "webp";

export interface ImagePreset {
  name: string;
  widths: number[];
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

export const PHOTO_PRESET: ImagePreset = {
  name: "photo",
  widths: [640, 1280, 1920],
  formats: ["avif", "webp"],
  encoders: {
    avif: { quality: 60, effort: 4 },
    webp: { quality: 78, effort: 4 },
  },
};

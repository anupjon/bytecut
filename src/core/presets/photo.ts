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

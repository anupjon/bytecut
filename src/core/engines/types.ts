import type { Placeholder, PlaceholderKind } from "../placeholders/types.js";
import type { ImageFormat } from "../presets/photo.js";

export type SourceFormat = "jpeg" | "png" | "webp" | "avif" | "gif" | "other";

/**
 * Everything the classifier and audit rules need from one decode. Cheap to store, so it is
 * cached by source hash (§M3 estimator cache).
 */
export interface ImageAnalysis {
  /** Dimensions after EXIF orientation is applied. */
  width: number;
  height: number;
  format: SourceFormat;
  hasAlpha: boolean;
  /** True when some pixel is actually not fully opaque (an alpha channel may be unused). */
  alphaUsed: boolean;
  animated: boolean;
  /** Colour space (`srgb`, `cmyk`, ...) and bit depth (`uchar`, `ushort`, ...) as libvips reports. */
  space: string;
  depth: string;
  /**
   * Distinct colours in a ≤64px nearest-neighbour sample with channels reduced to 5 bits, and
   * how many pixels were sampled. Flat art stays small; photographs saturate the sample.
   */
  colorCount: number;
  sampleSize: number;
  metadata: { exif: number; xmp: number; iptc: number; icc: number; gps: boolean };
}

export interface EncodeRequest {
  format: ImageFormat;
  /** Target width; never enlarges beyond the source. */
  width: number;
  lossless: boolean;
  quality: number;
  effort: number;
}

export interface EncodeResult {
  data: Buffer;
  width: number;
  height: number;
  /** Encoder actually used, including its version (recorded in the manifest). */
  encoder: string;
}

/** Behind an interface so the executor can be tested with a fake (§3). */
export interface ImageEngine {
  analyze(input: Buffer): Promise<ImageAnalysis>;
  encode(input: Buffer, request: EncodeRequest): Promise<EncodeResult>;
  /**
   * A tiny stand-in for the image while it loads. Optional so engines that cannot decode
   * images (fakes) need not implement it; callers skip placeholders when it is absent.
   */
  placeholder?(input: Buffer, kind: PlaceholderKind): Promise<Placeholder>;
  /** What `encode` would report for each format, so drift can be detected without encoding. */
  encoders(): Record<ImageFormat, string>;
  /** Informational tool versions for the manifest. */
  versions(): Record<string, string>;
}

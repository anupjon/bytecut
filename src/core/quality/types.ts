/** Tightly packed 8-bit sRGB, 3 bytes per pixel, row-major. Alpha is flattened before scoring. */
export interface RgbImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** SSIMULACRA2: 100 is identical, lower is worse; roughly 90 is indistinguishable, 70 high, 50 medium. */
export interface QualityScorer {
  /** Which implementation produced the scores; recorded because they differ in the last decimals. */
  readonly kind: "wasm" | "native";
  /** The implementation's identity for the manifest, e.g. `@bytecut/ssimulacra2 0.1.0`. */
  readonly label: string;
  score(reference: RgbImage, distorted: RgbImage): Promise<number>;
  close(): Promise<void>;
}

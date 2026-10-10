/** Tightly packed 8-bit sRGB, 3 bytes per pixel, row-major. */
export interface RgbImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export const MIN_SIDE: 8;

export interface Scorer {
  /** SSIMULACRA2 of `distorted` against `reference`: 100 is identical, lower is worse. */
  score(reference: RgbImage, distorted: RgbImage): number;
}

/** Compiles the WebAssembly module once per process. */
export function compile(): Promise<WebAssembly.Module>;

/** An instance in the current thread. */
export function loadScorer(module?: WebAssembly.Module): Promise<Scorer>;

export interface Pool {
  readonly size: number;
  score(reference: RgbImage, distorted: RgbImage): Promise<number>;
  close(): Promise<void>;
}

/** Worker threads, each with its own instance; scoring never blocks the caller. */
export function createPool(options?: { size?: number }): Pool;

import { BytecutError } from "../errors.js";
import type { QualityScorer } from "./types.js";

/**
 * The built-in scorer: SSIMULACRA2 as WebAssembly in worker threads. Loaded lazily, so a run
 * that never searches for a quality never pays for the module (or the workers).
 */
export async function createWasmScorer(options: { size?: number } = {}): Promise<QualityScorer> {
  let lib: typeof import("@bytecut/ssimulacra2");
  try {
    lib = await import("@bytecut/ssimulacra2");
  } catch (error) {
    throw new BytecutError(
      "SCORER_UNAVAILABLE",
      `The built-in SSIMULACRA2 scorer could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const pool = lib.createPool({ size: options.size ?? 2 });
  return {
    kind: "wasm",
    label: "@bytecut/ssimulacra2",
    score: (reference, distorted) => pool.score(reference, distorted),
    close: () => pool.close(),
  };
}

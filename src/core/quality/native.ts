import { BytecutError } from "../errors.js";
import type { Run } from "../ffmpeg/index.js";
import type { SafeFs } from "../fs-safe.js";
import type { QualityScorer, RgbImage } from "./types.js";

export interface NativeScorerOptions {
  /** Absolute path of the `ssimulacra2` executable (libjxl / cloudinary). */
  binary: string;
  /** Candidates are handed to the tool as files; they live in a temp area inside outDir (§6.2). */
  fs: SafeFs;
  /** Encodes an image as PNG, the format the reference tool reads everywhere. */
  toPng(image: RgbImage): Promise<Uint8Array>;
  run: Run;
}

let counter = 0;

/**
 * Runs the reference `ssimulacra2` tool (argument array, never a shell string, §6.14). Faster
 * than WASM on large images; WASM stays the default and the fallback.
 */
export function createNativeScorer(options: NativeScorerOptions): QualityScorer {
  return {
    kind: "native",
    label: `ssimulacra2 (${options.binary})`,
    async score(reference, distorted) {
      const id = `${process.pid}-${counter++}`;
      const paths: string[] = [];
      try {
        paths.push(
          await options.fs.writeTemp(
            `.bytecut-cache/tmp/${id}-a.png`,
            await options.toPng(reference),
          ),
          await options.fs.writeTemp(
            `.bytecut-cache/tmp/${id}-b.png`,
            await options.toPng(distorted),
          ),
        );
        const { stdout } = await options.run(options.binary, paths);
        const value = Number.parseFloat(stdout.trim().split(/\s+/).pop() ?? "");
        if (!Number.isFinite(value)) {
          throw new BytecutError(
            "SCORER_UNAVAILABLE",
            `${options.binary} printed something that is not a score: ${stdout.trim().slice(0, 80)}`,
          );
        }
        return value;
      } finally {
        await Promise.all(paths.map((p) => options.fs.discardTemp(p)));
      }
    },
    async close() {},
  };
}

import { resolveBinary, type ResolveDeps, type ResolvedBinary } from "../ffmpeg/index.js";
import type { SafeFs } from "../fs-safe.js";
import type { Run } from "../ffmpeg/index.js";
import { createNativeScorer } from "./native.js";
import type { QualityScorer, RgbImage } from "./types.js";
import { createWasmScorer } from "./wasm.js";

export interface SelectScorerOptions {
  /** `--ssimulacra2` flag and `ssimulacra2Path` from the config. */
  flag?: string | undefined;
  config?: string | undefined;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  deps: ResolveDeps;
  fs: SafeFs;
  toPng(image: RgbImage): Promise<Uint8Array>;
  run: Run;
  /** Worker threads for the WASM scorer. */
  size?: number;
}

export interface SelectedScorer {
  scorer: QualityScorer;
  /** Said once, before the first score: a path that was named but is not there, for example. */
  notes: string[];
}

export function resolveScorerBinary(
  options: Pick<SelectScorerOptions, "flag" | "config" | "env" | "platform" | "deps">,
): ResolvedBinary {
  return resolveBinary(
    "ssimulacra2",
    { flag: options.flag, config: options.config, env: options.env, platform: options.platform },
    options.deps,
  );
}

/**
 * flag → env → config → PATH, as ffmpeg is resolved (§4). A native tool is only faster; the
 * built-in WASM scorer is the default and the fallback, so nothing here can make a search
 * impossible. An explicitly named path that is missing is reported, never silently replaced
 * by a different binary on PATH.
 */
export async function selectScorer(options: SelectScorerOptions): Promise<SelectedScorer> {
  const resolved = resolveScorerBinary(options);
  const notes: string[] = [];
  if (resolved.found) {
    return {
      scorer: createNativeScorer({
        binary: resolved.path,
        fs: options.fs,
        toPng: options.toPng,
        run: options.run,
      }),
      notes,
    };
  }
  if (resolved.attempted) {
    notes.push(
      `ssimulacra2 not found at ${resolved.attempted} (from ${resolved.source}); using the built-in WebAssembly scorer.`,
    );
  }
  return {
    scorer: await createWasmScorer(options.size !== undefined ? { size: options.size } : {}),
    notes,
  };
}

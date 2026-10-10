import type { PlanItem } from "../plan/types.js";
import type { ManifestSource } from "./types.js";

export type CacheMissReason =
  | "new"
  | "source-changed"
  | "outputs-differ"
  | "output-missing"
  | "output-modified"
  | "output-stale";

export type CacheState = { kind: "hit" } | { kind: "miss"; reason: CacheMissReason };

/**
 * Same source hash + same resolved preset = skip (§4). Each planned output must also still
 * exist and match its recorded hash, so a deleted or hand-edited output is never "cached".
 * Extra manifest entries (orphans) don't break a hit.
 */
export async function checkCache(
  item: PlanItem,
  entry: ManifestSource | undefined,
  hashOutput: (path: string) => Promise<string | null>,
): Promise<CacheState> {
  if (!entry) return { kind: "miss", reason: "new" };
  if (entry.sha256 !== item.sourceSha256) return { kind: "miss", reason: "source-changed" };
  if (entry.preset !== item.preset) return { kind: "miss", reason: "outputs-differ" };

  const recorded = new Map(entry.outputs.map((o) => [o.path, o]));
  for (const planned of item.outputs) {
    const r = recorded.get(planned.path);
    if (
      !r ||
      r.format !== planned.format ||
      r.width !== planned.width ||
      r.lossless !== planned.lossless ||
      r.quality !== planned.quality ||
      r.effort !== planned.effort
    ) {
      return { kind: "miss", reason: "outputs-differ" };
    }
  }

  for (const planned of item.outputs) {
    const r = recorded.get(planned.path)!;
    if (r.status === "stale") return { kind: "miss", reason: "output-stale" };
    if (r.status !== "written") continue;
    const actual = await hashOutput(planned.path);
    if (actual === null) return { kind: "miss", reason: "output-missing" };
    if (actual !== r.sha256) return { kind: "miss", reason: "output-modified" };
  }
  return { kind: "hit" };
}

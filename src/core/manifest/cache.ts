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

import type { PlannedMediaOutput, VideoPlanItem } from "../plan/types.js";
import type { ManifestVideoOutput, ManifestVideoSource } from "./types.js";

function sameVideoParams(planned: PlannedMediaOutput, r: ManifestVideoOutput): boolean {
  if (planned.role !== r.role || planned.path !== r.path || planned.width !== r.width) return false;
  if (planned.role === "video") {
    return (
      r.codec === planned.codec &&
      r.crf === planned.crf &&
      r.speed === planned.speed &&
      r.maxWidth === planned.maxWidth &&
      r.maxFps === planned.maxFps &&
      r.audio === planned.audio
    );
  }
  return r.quality === planned.quality && r.effort === planned.effort && r.at === planned.at;
}

/** The video analogue of `checkCache`: same source hash, same planned parameters, files intact. */
export async function checkVideoCache(
  item: VideoPlanItem,
  entry: ManifestVideoSource | undefined,
  hashOutput: (path: string) => Promise<string | null>,
  /** Codecs with no installed encoder: their outputs cannot exist, so they don't count as misses. */
  unavailable: ReadonlySet<string> = new Set(),
): Promise<CacheState> {
  if (!entry) return { kind: "miss", reason: "new" };
  if (entry.sha256 !== item.sourceSha256) return { kind: "miss", reason: "source-changed" };
  if (entry.preset !== item.preset) return { kind: "miss", reason: "outputs-differ" };

  const recorded = new Map(entry.outputs.map((o) => [o.path, o]));
  const wanted = item.outputs.filter((o) => !(o.role === "video" && unavailable.has(o.codec)));
  for (const planned of wanted) {
    const r = recorded.get(planned.path);
    if (!r || !sameVideoParams(planned, r)) return { kind: "miss", reason: "outputs-differ" };
  }
  for (const planned of wanted) {
    const r = recorded.get(planned.path)!;
    if (r.status === "stale") return { kind: "miss", reason: "output-stale" };
    if (r.status !== "written") continue;
    const actual = await hashOutput(planned.path);
    if (actual === null) return { kind: "miss", reason: "output-missing" };
    if (actual !== r.sha256) return { kind: "miss", reason: "output-modified" };
  }
  return { kind: "hit" };
}

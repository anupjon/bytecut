import type { PlannedOutput, PlanItem } from "../plan/types.js";
import type { ManifestOutput, ManifestSource } from "./types.js";

export type CacheMissReason =
  | "new"
  | "source-changed"
  | "outputs-differ"
  | "output-missing"
  | "output-modified"
  | "output-stale";

export type CacheState = { kind: "hit" } | { kind: "miss"; reason: CacheMissReason };

/**
 * Recorded outputs keyed by the path the plan lists. A width stepped down to fit `maxSize`
 * lives at another path but is still the output the plan asked for.
 */
export function recordedByPlannedPath(entry: ManifestSource): Map<string, ManifestOutput> {
  return new Map(entry.outputs.map((o) => [o.search?.plannedPath ?? o.path, o]));
}

/** Whether a recorded output was made under the same search the plan asks for. */
function sameSearch(planned: PlannedOutput, r: ManifestOutput): boolean {
  const p = planned.search;
  const q = r.search;
  if (!p || !q) return !p && !q;
  return (
    p.metric === q.metric &&
    p.target === q.target &&
    p.floor === q.floor &&
    p.maxBytes === q.maxBytes
  );
}

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

  const recorded = recordedByPlannedPath(entry);
  for (const planned of item.outputs) {
    const r = recorded.get(planned.path);
    // A searched output is valid under the same search parameters whatever quality it landed
    // on, and its width may have been stepped down; a fixed one must match exactly.
    const searched = planned.search !== undefined;
    if (
      !r ||
      r.format !== planned.format ||
      r.lossless !== planned.lossless ||
      r.effort !== planned.effort ||
      !sameSearch(planned, r) ||
      (searched
        ? r.width > planned.width
        : r.width !== planned.width || r.quality !== planned.quality)
    ) {
      return { kind: "miss", reason: "outputs-differ" };
    }
  }

  for (const planned of item.outputs) {
    const r = recorded.get(planned.path)!;
    if (r.status === "stale") return { kind: "miss", reason: "output-stale" };
    if (r.status !== "written") continue;
    const actual = await hashOutput(r.path);
    if (actual === null) return { kind: "miss", reason: "output-missing" };
    if (actual !== r.sha256) return { kind: "miss", reason: "output-modified" };
  }
  return { kind: "hit" };
}

import type { PlannedMediaOutput, VideoPlanItem } from "../plan/types.js";
import type { ManifestVideoOutput, ManifestVideoSource } from "./types.js";

/**
 * Recorded video outputs keyed by the path the plan lists: a width stepped down to fit a size
 * cap lives at another path but is still the output the plan asked for.
 */
export function recordedVideoByPlannedPath(
  entry: ManifestVideoSource,
): Map<string, ManifestVideoOutput> {
  return new Map(entry.outputs.map((o) => [o.search?.plannedPath ?? o.path, o]));
}

export function sameVideoParams(planned: PlannedMediaOutput, r: ManifestVideoOutput): boolean {
  if (planned.role !== r.role) return false;
  if (planned.role === "video") {
    // A searched output is valid for the target it was searched for, wherever the CRF landed.
    const search = planned.search;
    // Stepped down to fit a cap, the file is narrower than planned and named for its width.
    if (r.search?.plannedPath !== undefined) {
      if (r.search.plannedPath !== planned.path || r.width > planned.width) return false;
    } else if (planned.path !== r.path || planned.width !== r.width) {
      return false;
    }
    const sameSearch =
      search === undefined
        ? r.search === undefined && r.crf === planned.crf
        : r.search?.metric === search.metric &&
          r.search.target === search.target &&
          r.search.floor === search.floor &&
          r.search.maxBytes === search.maxBytes;
    return (
      sameSearch &&
      r.codec === planned.codec &&
      r.speed === planned.speed &&
      r.maxWidth === planned.maxWidth &&
      r.maxFps === planned.maxFps &&
      r.audio === planned.audio
    );
  }
  if (planned.path !== r.path || planned.width !== r.width) return false;
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

  const recorded = recordedVideoByPlannedPath(entry);
  const wanted = item.outputs.filter((o) => !(o.role === "video" && unavailable.has(o.codec)));
  for (const planned of wanted) {
    const r = recorded.get(planned.path);
    if (!r || !sameVideoParams(planned, r)) return { kind: "miss", reason: "outputs-differ" };
  }
  for (const planned of wanted) {
    const r = recorded.get(planned.path)!;
    if (r.status === "stale") return { kind: "miss", reason: "output-stale" };
    if (r.status !== "written") continue;
    const actual = await hashOutput(r.path);
    if (actual === null) return { kind: "miss", reason: "output-missing" };
    if (actual !== r.sha256) return { kind: "miss", reason: "output-modified" };
  }
  return { kind: "hit" };
}

import type {
  ItemResult,
  OutputResult,
  RunResult,
  VideoItemResult,
  VideoOutputResult,
} from "../execute/run.js";
import type { Plan } from "../plan/types.js";
import {
  MANIFEST_VERSION,
  type Manifest,
  type ManifestOutput,
  type ManifestSource,
  type ManifestVideoOutput,
  type ManifestVideoSource,
} from "./types.js";

export function outputUrl(publicPath: string, path: string): string {
  return `${publicPath.replace(/\/+$/, "")}/${path}`;
}

function toManifestOutput(out: OutputResult, publicPath: string): ManifestOutput {
  return {
    path: out.path,
    url: outputUrl(publicPath, out.path),
    format: out.format,
    width: out.width,
    height: out.height,
    bytes: out.bytes,
    ...(out.status === "already-optimal" ? {} : { sha256: out.sha256! }),
    lossless: out.lossless,
    quality: out.quality,
    effort: out.effort,
    encoder: out.encoder ?? "unknown",
    status: out.status === "already-optimal" ? "already-optimal" : "written",
  };
}

function mergeItem(
  old: ManifestSource | undefined,
  item: ItemResult,
  plannedPaths: Set<string>,
  publicPath: string,
): ManifestSource | null {
  const produced = new Map<string, ManifestOutput>();
  for (const out of item.outputs) {
    if (
      out.status === "written" ||
      out.status === "unchanged" ||
      out.status === "already-optimal"
    ) {
      produced.set(out.path, toManifestOutput(out, publicPath));
    }
  }
  // Nothing was produced (all failed, protected, or cancelled): leave the old entry alone.
  if (produced.size === 0) return null;

  const sameSource = old?.sha256 === item.sourceSha256;
  const merged = new Map(produced);
  for (const previous of old?.outputs ?? []) {
    if (merged.has(previous.path)) continue;
    if (plannedPaths.has(previous.path) && !sameSource) {
      // The file on disk was made from an older source and this run didn't replace it.
      merged.set(previous.path, { ...previous, status: "stale" });
    } else {
      // Still valid, or an orphan the current plan doesn't produce: keep it listed so it
      // remains deletable (§6.3).
      merged.set(previous.path, previous);
    }
  }

  return {
    sha256: item.sourceSha256,
    bytes: item.sourceBytes,
    width: item.sourceWidth,
    height: item.sourceHeight,
    preset: item.preset,
    outputs: [...merged.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

function toManifestVideoOutput(out: VideoOutputResult, publicPath: string): ManifestVideoOutput {
  return {
    path: out.path,
    url: outputUrl(publicPath, out.path),
    role: out.role,
    format: out.format,
    ...(out.codec ? { codec: out.codec } : {}),
    width: out.width,
    height: out.height,
    ...(out.fps !== undefined ? { fps: out.fps } : {}),
    bytes: out.bytes,
    ...(out.status === "already-optimal" || !out.sha256 ? {} : { sha256: out.sha256 }),
    ...(out.crf !== undefined ? { crf: out.crf } : {}),
    ...(out.speed !== undefined ? { speed: out.speed } : {}),
    ...(out.maxWidth !== undefined ? { maxWidth: out.maxWidth } : {}),
    ...(out.maxFps !== undefined ? { maxFps: out.maxFps } : {}),
    ...(out.audio !== undefined ? { audio: out.audio } : {}),
    ...(out.quality !== undefined ? { quality: out.quality } : {}),
    ...(out.effort !== undefined ? { effort: out.effort } : {}),
    ...(out.at !== undefined ? { at: out.at } : {}),
    encoder: out.encoder ?? "unknown",
    status: out.status === "already-optimal" ? "already-optimal" : "written",
  };
}

/** Same rules as images: keep what is still valid, mark what an older source left behind stale. */
function mergeVideoItem(
  old: ManifestVideoSource | undefined,
  item: VideoItemResult,
  plannedPaths: Set<string>,
  publicPath: string,
): ManifestVideoSource | null {
  const produced = new Map<string, ManifestVideoOutput>();
  for (const out of item.outputs) {
    if (
      out.status === "written" ||
      out.status === "unchanged" ||
      out.status === "already-optimal"
    ) {
      produced.set(out.path, toManifestVideoOutput(out, publicPath));
    }
  }
  if (produced.size === 0) return null;

  const sameSource = old?.sha256 === item.sourceSha256;
  const merged = new Map(produced);
  for (const previous of old?.outputs ?? []) {
    if (merged.has(previous.path)) continue;
    if (plannedPaths.has(previous.path) && !sameSource) {
      merged.set(previous.path, { ...previous, status: "stale" });
    } else {
      merged.set(previous.path, previous);
    }
  }
  return {
    sha256: item.sourceSha256,
    bytes: item.sourceBytes,
    width: item.sourceWidth,
    height: item.sourceHeight,
    durationSec: item.durationSec,
    preset: item.preset,
    outputs: [...merged.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/** Pure: returns the manifest as it should be after `result`, leaving `previous` untouched. */
export function updateManifest(
  previous: Manifest | null,
  plan: Plan,
  result: RunResult,
  tools: Record<string, string>,
): Manifest {
  const sources: Record<string, ManifestSource> = { ...previous?.sources };
  const planned = new Map(plan.items.map((i) => [i.source, i]));

  for (const item of result.items) {
    if (item.status === "skipped" || item.status === "cached") continue;
    const plannedPaths = new Set(planned.get(item.source)?.outputs.map((o) => o.path));
    const merged = mergeItem(sources[item.source], item, plannedPaths, plan.publicPath);
    if (merged) sources[item.source] = merged;
  }

  const videos: Record<string, ManifestVideoSource> = { ...previous?.videos };
  const plannedVideos = new Map((plan.videos ?? []).map((v) => [v.source, v]));
  for (const item of result.videos ?? []) {
    if (item.status === "skipped" || item.status === "cached") continue;
    const plannedPaths = new Set(plannedVideos.get(item.source)?.outputs.map((o) => o.path));
    const merged = mergeVideoItem(videos[item.source], item, plannedPaths, plan.publicPath);
    if (merged) videos[item.source] = merged;
  }

  // Keep URLs consistent if the public path changed since an older run.
  for (const entry of Object.values(sources)) {
    entry.outputs = entry.outputs.map((o) => ({ ...o, url: outputUrl(plan.publicPath, o.path) }));
  }
  for (const entry of Object.values(videos)) {
    entry.outputs = entry.outputs.map((o) => ({ ...o, url: outputUrl(plan.publicPath, o.path) }));
  }

  return { version: MANIFEST_VERSION, tools, publicPath: plan.publicPath, sources, videos };
}

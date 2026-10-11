import { resolve } from "node:path";
import type { EncodeResult, ImageEngine } from "../engines/types.js";
import { sha256 } from "../hash.js";
import { checkCache, recordedByPlannedPath, type CacheMissReason } from "../manifest/cache.js";
import type { Manifest } from "../manifest/types.js";
import type { Plan, PlanItem, VideoPlanItem } from "../plan/types.js";
import type { VideoEngine } from "../video/types.js";
import { runVideoItem, type VideoLaneFs } from "./video.js";
import type { ImageFormat, QualitySearch } from "../presets/photo.js";
import type { QualityScorer } from "../quality/types.js";
import { searchQuality } from "../quality/search.js";

/**
 * written: encoded and written. unchanged: an identical file was already on disk.
 * already-optimal: not smaller than the source, so not written (§6.7).
 * protected: a file we don't own is in the way, so it was left alone (§6.6).
 */
export type OutputStatus =
  | "written"
  | "unchanged"
  | "already-optimal"
  | "protected"
  /** The encoder this output needs is not installed (e.g. no AV1 encoder). */
  | "unavailable"
  /** A configured quality or size constraint could not be met; nothing was written. */
  | "unmet"
  | "failed"
  | "cancelled";

export interface OutputResult {
  path: string;
  format: ImageFormat;
  width: number;
  height: number;
  bytes: number;
  lossless: boolean;
  quality: number;
  effort: number;
  sha256?: string;
  encoder?: string;
  /** Present when the quality came from a perceptual search. */
  search?: QualitySearch & { plannedPath?: string };
  score?: number;
  scorer?: "wasm" | "native";
  status: OutputStatus;
  error?: string;
}

export interface ItemResult {
  source: string;
  sourceBytes: number;
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  preset: string;
  /** `cached`: nothing needed doing; outputs came from the manifest. */
  status: "done" | "cached" | "skipped" | "failed" | "cancelled";
  reason?: string;
  outputs: OutputResult[];
}

export interface VideoOutputResult {
  path: string;
  role: "video" | "poster";
  /** `mp4` for videos, `avif` for posters. */
  format: "mp4" | "avif";
  codec?: "av1" | "h264";
  width: number;
  height: number;
  fps?: number;
  bytes: number;
  sha256?: string;
  /** Parameters the output was made with, recorded so the cache can compare them. */
  crf?: number;
  speed?: string;
  maxWidth?: number | null;
  maxFps?: number | null;
  audio?: "strip" | "keep";
  quality?: number;
  effort?: number;
  at?: number;
  /** RFC 6381 codecs for `<source type>`. */
  codecs?: string;
  encoder?: string;
  /** Present when the CRF came from a perceptual search. */
  search?: { metric: "ssimulacra2" | "vmaf"; target: number };
  score?: number;
  scorer?: "wasm" | "native" | "libvmaf";
  status: OutputStatus;
  error?: string;
}

export interface VideoItemResult {
  source: string;
  sourceBytes: number;
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  durationSec: number;
  preset: string;
  status: "done" | "cached" | "skipped" | "failed" | "cancelled";
  reason?: string;
  outputs: VideoOutputResult[];
}

export interface RunResult {
  items: ItemResult[];
  /** Video results; absent when the plan had no videos. */
  videos?: VideoItemResult[];
  cancelled: boolean;
  /** Human-readable notes, e.g. outputs left alone because they were modified. */
  warnings: string[];
}

export interface RunOptions {
  /** Absolute path of the project root; plan paths are relative to it. */
  projectRoot: string;
  engine: ImageEngine;
  fs: {
    readSource(absolutePath: string): Promise<Buffer>;
    readOutput(relativePosixPath: string): Promise<Buffer | null>;
    writeOutput(relativePosixPath: string, data: Uint8Array): Promise<void>;
  } & Partial<VideoLaneFs>;
  /** Present when ffmpeg is usable; without it videos are reported as needing it. */
  video?: {
    engine: VideoEngine;
    /** Videos encoded at once (default 1: SVT-AV1 already uses every core). */
    concurrency?: number;
    /** Shown with "needs ffmpeg" when there is no engine. */
    needsFfmpeg?: string;
  };
  /**
   * Perceptual search. Absent means outputs with a `search` fall back to their fixed quality,
   * with a warning, rather than failing the run.
   */
  quality?: { scorer(): Promise<QualityScorer> };
  manifest: Manifest | null;
  /** Re-encode even when unchanged, and overwrite outputs we don't own. */
  force?: boolean;
  concurrency?: number;
  signal?: AbortSignal;
  onItemStart?(source: string): void;
  /** Fires as each output of an item is resolved, so a UI can show live progress. */
  onOutputDone?(source: string, output: OutputResult): void;
  onItemDone?(result: ItemResult, done: number, total: number): void;
  onVideoItemStart?(source: string): void;
  /** Encode progress for one video output, 0..1. */
  onVideoProgress?(source: string, path: string, fraction: number): void;
  onVideoOutputDone?(source: string, output: VideoOutputResult): void;
  onVideoItemDone?(result: VideoItemResult, done: number, total: number): void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function header(item: PlanItem) {
  return {
    source: item.source,
    sourceBytes: item.sourceBytes,
    sourceSha256: item.sourceSha256,
    sourceWidth: item.sourceWidth,
    sourceHeight: item.sourceHeight,
    preset: item.preset,
  };
}

async function runItem(
  item: PlanItem,
  options: RunOptions,
  owned: Map<string, string>,
  warnings: string[],
): Promise<ItemResult> {
  const base = header(item);
  if (item.skip) return { ...base, status: "skipped", reason: item.skip.reason, outputs: [] };

  let input: Buffer;
  try {
    input = await options.fs.readSource(resolve(options.projectRoot, ...item.source.split("/")));
  } catch (error) {
    return { ...base, status: "failed", reason: message(error), outputs: [] };
  }

  // A saved plan (or a file edited mid-run) must never be applied to different bytes.
  if (sha256(input) !== item.sourceSha256) {
    return {
      ...base,
      status: "failed",
      reason: "source changed since the plan was created; re-run to build a fresh plan",
      outputs: [],
    };
  }

  const hashOutput = async (path: string) => {
    const data = await options.fs.readOutput(path);
    return data ? sha256(data) : null;
  };

  const entry = options.manifest?.sources[item.source];
  if (!options.force && entry) {
    const state = await checkCache(item, entry, hashOutput);
    if (state.kind === "hit") {
      const recorded = recordedByPlannedPath(entry);
      const outputs = item.outputs.map((planned): OutputResult => {
        const r = recorded.get(planned.path)!;
        return {
          path: r.path,
          format: r.format,
          width: r.width,
          height: r.height,
          bytes: r.bytes,
          lossless: r.lossless,
          quality: r.quality,
          effort: r.effort,
          ...(r.sha256 ? { sha256: r.sha256 } : {}),
          encoder: r.encoder,
          ...(r.search ? { search: r.search } : {}),
          ...(r.score !== undefined ? { score: r.score } : {}),
          ...(r.scorer ? { scorer: r.scorer } : {}),
          status: r.status === "already-optimal" ? "already-optimal" : "unchanged",
        };
      });
      return { ...base, status: "cached", outputs };
    }
  }

  const outputs: OutputResult[] = [];
  const record = (output: OutputResult) => {
    outputs.push(output);
    options.onOutputDone?.(item.source, output);
  };
  let failed = false;
  for (const planned of item.outputs) {
    const shared = {
      path: planned.path,
      format: planned.format,
      lossless: planned.lossless,
      quality: planned.quality,
      effort: planned.effort,
    };
    if (options.signal?.aborted) {
      record({ ...shared, width: planned.width, height: 0, bytes: 0, status: "cancelled" });
      continue;
    }
    try {
      let encoded: EncodeResult | undefined;
      let outPath = planned.path;
      let quality = planned.quality;
      let searched: Pick<OutputResult, "search" | "score" | "scorer"> = {};

      if (planned.search && !planned.lossless && options.quality) {
        const biggerSibling = Math.max(
          0,
          ...item.outputs
            .filter((o) => o.format === planned.format && o.width < planned.width)
            .map((o) => o.width),
        );
        const scorer = await options.quality.scorer();
        const outcome = await searchQuality({
          engine: options.engine,
          scorer,
          input,
          format: planned.format,
          width: planned.width,
          effort: planned.effort,
          search: planned.search,
          minWidth: biggerSibling,
          signal: options.signal,
        });
        if (outcome.ok) {
          encoded = outcome.encoded;
          quality = outcome.quality;
          const stepped = outcome.width !== planned.width;
          if (stepped) {
            // The file is named for what it is; the manifest remembers what it stands in for.
            outPath = planned.path.replace(
              new RegExp(`-${planned.width}\\.${planned.format}$`),
              `-${outcome.width}.${planned.format}`,
            );
          }
          searched = {
            search: { ...planned.search, ...(stepped ? { plannedPath: planned.path } : {}) },
            score: Math.round(outcome.score * 100) / 100,
            scorer: scorer.kind,
          };
          for (const note of outcome.notes) warnings.push(`${outPath}: ${note}`);
        } else if (outcome.cancelled) {
          record({ ...shared, width: planned.width, height: 0, bytes: 0, status: "cancelled" });
          continue;
        } else if (outcome.unsearchable) {
          warnings.push(
            `${planned.path}: perceptual search was not possible (${outcome.reason}); used quality ${planned.quality}`,
          );
        } else {
          record({
            ...shared,
            width: planned.width,
            height: 0,
            bytes: 0,
            status: "unmet",
            error: outcome.reason,
          });
          // A constraint the user configured was not met: the run reports failure.
          failed = true;
          continue;
        }
      } else if (planned.search && !planned.lossless) {
        warnings.push(
          `${planned.path}: no quality scorer available; used the fixed quality ${planned.quality} instead of the ssimulacra2 target`,
        );
      }

      encoded ??= await options.engine.encode(input, planned);
      const result = {
        ...shared,
        path: outPath,
        quality,
        width: encoded.width,
        height: encoded.height,
        bytes: encoded.data.byteLength,
        encoder: encoded.encoder,
        ...searched,
      };

      // §6.7: never emit a file larger than what we started with.
      if (encoded.data.byteLength >= item.sourceBytes) {
        record({ ...result, status: "already-optimal" });
        continue;
      }

      const newHash = sha256(encoded.data);
      const onDisk = await options.fs.readOutput(outPath);
      if (onDisk) {
        const diskHash = sha256(onDisk);
        if (diskHash === newHash) {
          record({ ...result, sha256: newHash, status: "unchanged" });
          continue;
        }
        // §6.6: only replace files the manifest says are ours and unmodified.
        if (!options.force && owned.get(outPath) !== diskHash) {
          warnings.push(
            `${outPath}: a file is already there that bytecut did not write or that was edited; left alone (use --force to overwrite)`,
          );
          record({ ...result, status: "protected" });
          continue;
        }
      }

      await options.fs.writeOutput(outPath, encoded.data);
      record({ ...result, sha256: newHash, status: "written" });
    } catch (error) {
      failed = true;
      record({
        ...shared,
        width: planned.width,
        height: 0,
        bytes: 0,
        status: "failed",
        error: message(error),
      });
    }
  }

  const cancelled = outputs.some((o) => o.status === "cancelled");
  return { ...base, status: failed ? "failed" : cancelled ? "cancelled" : "done", outputs };
}

/** Bounded-concurrency pool over plan items. One item failing never aborts the rest. */
export async function runPlan(plan: Plan, options: RunOptions): Promise<RunResult> {
  const results = new Array<ItemResult>(plan.items.length);
  const warnings: string[] = [];

  // path → sha256 for every file the manifest says bytecut wrote.
  const owned = new Map<string, string>();
  for (const source of Object.values(options.manifest?.sources ?? {})) {
    for (const out of source.outputs) if (out.sha256) owned.set(out.path, out.sha256);
  }
  for (const source of Object.values(options.manifest?.videos ?? {})) {
    for (const out of source.outputs) if (out.sha256) owned.set(out.path, out.sha256);
  }

  let next = 0;
  let done = 0;
  const workers = Math.max(1, Math.min(options.concurrency ?? 2, Math.max(1, plan.items.length)));

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      const item = plan.items[index];
      if (!item) return;
      let result: ItemResult;
      if (options.signal?.aborted) {
        result = { ...header(item), status: "cancelled", outputs: [] };
      } else {
        options.onItemStart?.(item.source);
        result = await runItem(item, options, owned, warnings);
      }
      results[index] = result;
      options.onItemDone?.(result, ++done, plan.items.length);
    }
  }

  // Videos run in their own lane with its own limit, alongside the (quick) image lane.
  const videoItems = plan.videos ?? [];
  const videoResults = new Array<VideoItemResult>(videoItems.length);
  let videoNext = 0;
  let videoDone = 0;
  const videoWorkers = Math.max(
    1,
    Math.min(options.video?.concurrency ?? 1, Math.max(1, videoItems.length)),
  );
  const videoWarnings = new Set<string>();

  async function videoWorker(): Promise<void> {
    for (;;) {
      const index = videoNext++;
      const item = videoItems[index];
      if (!item) return;
      let result: VideoItemResult;
      const lane = options.video;
      const fs = options.fs;
      if (options.signal?.aborted) {
        result = videoHeader(item, "cancelled");
      } else if (!lane || !fs.reserveTemp || !fs.commitTemp || !fs.discardTemp || !fs.outputPath) {
        result = videoHeader(item, "skipped", `needs ffmpeg: ${lane?.needsFfmpeg ?? "not found"}`);
      } else {
        options.onVideoItemStart?.(item.source);
        result = await runVideoItem(item, {
          projectRoot: options.projectRoot,
          engine: lane.engine,
          imageEngine: options.engine,
          fs: fs as VideoLaneFs,
          manifest: options.manifest,
          force: options.force ?? false,
          signal: options.signal,
          owned,
          warnings: videoWarnings,
          quality: options.quality,
          onProgress: options.onVideoProgress,
          onOutputDone: options.onVideoOutputDone,
        });
      }
      videoResults[index] = result;
      options.onVideoItemDone?.(result, ++videoDone, videoItems.length);
    }
  }

  await Promise.all([
    ...Array.from({ length: workers }, worker),
    ...(videoItems.length > 0 ? Array.from({ length: videoWorkers }, videoWorker) : []),
  ]);
  for (const w of videoWarnings) warnings.push(w);
  return {
    items: results,
    ...(videoItems.length > 0 ? { videos: videoResults } : {}),
    cancelled: options.signal?.aborted ?? false,
    warnings: warnings.sort(),
  };
}

function videoHeader(
  item: VideoPlanItem,
  status: VideoItemResult["status"],
  reason?: string,
): VideoItemResult {
  return {
    source: item.source,
    sourceBytes: item.sourceBytes,
    sourceSha256: item.sourceSha256,
    sourceWidth: item.sourceWidth,
    sourceHeight: item.sourceHeight,
    durationSec: item.durationSec,
    preset: item.preset,
    status,
    ...(reason ? { reason } : {}),
    outputs: [],
  };
}

export type { CacheMissReason };

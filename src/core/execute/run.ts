import { resolve } from "node:path";
import type { ImageEngine } from "../engines/types.js";
import { sha256 } from "../hash.js";
import { checkCache, type CacheMissReason } from "../manifest/cache.js";
import type { Manifest } from "../manifest/types.js";
import type { Plan, PlanItem } from "../plan/types.js";
import type { ImageFormat } from "../presets/photo.js";

/**
 * written: encoded and written. unchanged: an identical file was already on disk.
 * already-optimal: not smaller than the source, so not written (§6.7).
 * protected: a file we don't own is in the way, so it was left alone (§6.6).
 */
export type OutputStatus =
  "written" | "unchanged" | "already-optimal" | "protected" | "failed" | "cancelled";

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

export interface RunResult {
  items: ItemResult[];
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
  };
  manifest: Manifest | null;
  /** Re-encode even when unchanged, and overwrite outputs we don't own. */
  force?: boolean;
  concurrency?: number;
  signal?: AbortSignal;
  onItemDone?(result: ItemResult, done: number, total: number): void;
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
      const recorded = new Map(entry.outputs.map((o) => [o.path, o]));
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
          status: r.status === "already-optimal" ? "already-optimal" : "unchanged",
        };
      });
      return { ...base, status: "cached", outputs };
    }
  }

  const outputs: OutputResult[] = [];
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
      outputs.push({ ...shared, width: planned.width, height: 0, bytes: 0, status: "cancelled" });
      continue;
    }
    try {
      const encoded = await options.engine.encode(input, planned);
      const result = {
        ...shared,
        width: encoded.width,
        height: encoded.height,
        bytes: encoded.data.byteLength,
        encoder: encoded.encoder,
      };

      // §6.7: never emit a file larger than what we started with.
      if (encoded.data.byteLength >= item.sourceBytes) {
        outputs.push({ ...result, status: "already-optimal" });
        continue;
      }

      const newHash = sha256(encoded.data);
      const onDisk = await options.fs.readOutput(planned.path);
      if (onDisk) {
        const diskHash = sha256(onDisk);
        if (diskHash === newHash) {
          outputs.push({ ...result, sha256: newHash, status: "unchanged" });
          continue;
        }
        // §6.6: only replace files the manifest says are ours and unmodified.
        if (!options.force && owned.get(planned.path) !== diskHash) {
          warnings.push(
            `${planned.path}: a file is already there that bytecut did not write or that was edited; left alone (use --force to overwrite)`,
          );
          outputs.push({ ...result, status: "protected" });
          continue;
        }
      }

      await options.fs.writeOutput(planned.path, encoded.data);
      outputs.push({ ...result, sha256: newHash, status: "written" });
    } catch (error) {
      failed = true;
      outputs.push({
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

  let next = 0;
  let done = 0;
  const workers = Math.max(1, Math.min(options.concurrency ?? 2, plan.items.length));

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      const item = plan.items[index];
      if (!item) return;
      const result: ItemResult = options.signal?.aborted
        ? { ...header(item), status: "cancelled", outputs: [] }
        : await runItem(item, options, owned, warnings);
      results[index] = result;
      options.onItemDone?.(result, ++done, plan.items.length);
    }
  }

  await Promise.all(Array.from({ length: workers }, worker));
  return { items: results, cancelled: options.signal?.aborted ?? false, warnings: warnings.sort() };
}

export type { CacheMissReason };

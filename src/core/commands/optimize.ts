import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runProjectRules } from "../audit/run.js";
import type { Finding } from "../audit/types.js";
import { AnalysisCache } from "../cache/store.js";
import { classify } from "../classify/classify.js";
import type { ImageAnalysis, ImageEngine } from "../engines/types.js";
import {
  runPlan,
  type ItemResult,
  type OutputResult,
  type RunResult,
  type VideoItemResult,
  type VideoOutputResult,
} from "../execute/run.js";
import { SafeFs } from "../fs-safe.js";
import { sha256 } from "../hash.js";
import { checkCache, checkVideoCache, type CacheState } from "../manifest/cache.js";
import { parseManifest, serializeManifest } from "../manifest/io.js";
import { MANIFEST_FILE, type Manifest } from "../manifest/types.js";
import { updateManifest } from "../manifest/update.js";
import { buildPlan, DEFAULT_PUBLIC_PATH, type PresetChoice } from "../plan/build.js";
import { withVideos } from "./plan-media.js";
import type { Plan } from "../plan/types.js";
import { getImagePreset } from "../presets/index.js";
import { collectAssets } from "../scan/collect.js";
import type { VideoEngine } from "../video/types.js";

export interface OptimizeOptions {
  projectRoot: string;
  engine: ImageEngine;
  /** bytecut's own version, recorded in the manifest. */
  toolVersion: string;
  /** Either paths to scan or a previously saved plan. */
  inputs?: string[];
  savedPlan?: Plan;
  outDir: string;
  /** Folder served at the site root (relative to projectRoot); drives the mirrored layout. */
  staticRoot?: string;
  publicPath?: string;
  /** Force one preset for every image instead of classifying. */
  presetOverride?: string;
  /** Per-file preset by source path (relative, POSIX); wins over `presetOverride` and the classifier. */
  presetOverrides?: Record<string, string>;
  /** Write outputs. When false only the plan and findings are produced. */
  execute: boolean;
  force?: boolean;
  concurrency?: number;
  signal?: AbortSignal;
  onItemStart?(source: string): void;
  onOutputDone?(source: string, output: OutputResult): void;
  onItemDone?(result: ItemResult, done: number, total: number): void;
  /** Video lane. Absent engine means "no ffmpeg": videos are listed, not processed. */
  videoEngine?: VideoEngine | null;
  /** What to tell the user to install when there is no ffmpeg. */
  needsFfmpeg?: string;
  videoConcurrency?: number;
  onVideoItemStart?(source: string): void;
  onVideoProgress?(source: string, path: string, fraction: number): void;
  onVideoOutputDone?(source: string, output: VideoOutputResult): void;
  onVideoItemDone?(result: VideoItemResult, done: number, total: number): void;
}

export interface OptimizeOutcome {
  plan: Plan;
  /** Cache state per source in the plan (non-skipped items only). */
  cache: Map<string, CacheState>;
  /** Project rule findings; after a run these reflect the updated manifest. */
  findings: Finding[];
  /** Explicitly named files that couldn't be processed. */
  unsupported: string[];
  /** Found but not handled by `optimize`: SVGs and videos (absolute paths). */
  svgs: string[];
  videos: string[];
  /** Degradations and other things worth saying before anything runs (§4). */
  notes: string[];
  /** Present only when `execute` was true. */
  result?: RunResult;
}

export function engineFingerprint(engine: ImageEngine, extra: Record<string, string> = {}): string {
  const v = { ...engine.versions(), ...extra };
  return Object.keys(v)
    .sort()
    .map((k) => `${k}=${v[k]}`)
    .join(";");
}

export async function optimize(options: OptimizeOptions): Promise<OptimizeOutcome> {
  const { projectRoot, engine } = options;
  const outDir = resolve(projectRoot, options.outDir);

  let plan: Plan | undefined = options.savedPlan;
  let sourceFiles: string[];
  let sourceDirs: string[] = [];
  let unsupported: string[] = [];
  let svgs: string[] = [];
  let videos: string[] = [];

  // Reads of sources and writes both go through the same SafeFs, created from the file list.
  if (plan) {
    sourceFiles = [...plan.items, ...(plan.videos ?? [])].map((i) =>
      resolve(projectRoot, ...i.source.split("/")),
    );
  } else {
    const found = await collectAssets(options.inputs ?? [], { cwd: projectRoot, outDir });
    sourceFiles = [...found.files, ...found.videos];
    sourceDirs = found.sourceDirs;
    unsupported = found.unsupported;
    svgs = found.svgs;
    videos = found.videos;
    if (found.files.length === 0 && found.videos.length === 0) {
      return {
        plan: {
          version: 1,
          outDir: "",
          publicPath: options.publicPath ?? DEFAULT_PUBLIC_PATH,
          items: [],
        },
        cache: new Map(),
        findings: [],
        unsupported,
        svgs,
        videos,
        notes: [],
      };
    }
  }

  const fs = await SafeFs.create({ projectRoot, outDir, sourceFiles, sourceDirs });

  // Analysis (a pixel decode) is cached by content hash; a cold run just computes it.
  const videoVersions = options.videoEngine ? await options.videoEngine.versions() : {};
  const analysisCache = await AnalysisCache.load(fs, engineFingerprint(engine, videoVersions));
  const analyze = async (data: Buffer, digest: string): Promise<ImageAnalysis> => {
    const cached = analysisCache.getAnalysis(digest);
    if (cached) return cached;
    const fresh = await engine.analyze(data);
    analysisCache.setAnalysis(digest, fresh);
    return fresh;
  };

  const override = options.presetOverride ? getImagePreset(options.presetOverride) : null;
  const choosePreset = (source: string, analysis: ImageAnalysis): PresetChoice => {
    const perFile = options.presetOverrides?.[source];
    if (perFile) {
      return { preset: getImagePreset(perFile), reason: `set to ${perFile} for this file` };
    }
    if (override) {
      return { preset: override, reason: `forced with --preset ${override.name}` };
    }
    const verdict = classify(source, analysis);
    return {
      preset: getImagePreset(verdict.preset),
      reason: verdict.reason,
      confidence: verdict.confidence,
    };
  };

  if (!plan) {
    const rasterFiles = sourceFiles.filter((f) => !videos.includes(f));
    plan = await buildPlan({
      files: rasterFiles,
      projectRoot,
      outDir,
      ...(options.staticRoot !== undefined ? { staticRoot: options.staticRoot } : {}),
      ...(options.publicPath ? { publicPath: options.publicPath } : {}),
      choosePreset,
      engine,
      analyze,
      readSource: (path) => fs.readSource(path),
    });

    plan = await withVideos(plan, {
      projectRoot,
      staticRoot: options.staticRoot ?? ".",
      videoFiles: videos,
      videoEngine: options.videoEngine ?? null,
      needsFfmpeg: options.needsFfmpeg ?? "install ffmpeg",
      presetOverrides: options.presetOverrides,
      cache: analysisCache,
    });
  }

  const finalPlan: Plan = plan;
  const manifest = await readManifest(fs);
  const outputHash = async (path: string) => {
    const data = await fs.readOutput(path);
    return data ? sha256(data) : null;
  };

  const cache = new Map<string, CacheState>();
  for (const item of finalPlan.items) {
    if (item.skip) continue;
    cache.set(item.source, await checkCache(item, manifest?.sources[item.source], outputHash));
  }
  const caps = options.videoEngine ? await options.videoEngine.capabilities() : null;
  const missingCodecs = new Set<string>();
  if (caps) {
    if (!caps.libsvtav1 && !caps.libaomAv1) missingCodecs.add("av1");
    if (!caps.libx264) missingCodecs.add("h264");
  }
  const notes = videoNotes(finalPlan, caps, options.needsFfmpeg);
  for (const item of finalPlan.videos ?? []) {
    if (item.skip) continue;
    cache.set(
      item.source,
      await checkVideoCache(item, manifest?.videos[item.source], outputHash, missingCodecs),
    );
  }

  const ffmpegVersion = videoVersions.ffmpeg;
  const videoEncoders: Partial<Record<"av1" | "h264", string>> = {};
  if (caps && ffmpegVersion) {
    const av1 = caps.libsvtav1 ? "libsvtav1" : caps.libaomAv1 ? "libaom-av1" : null;
    if (av1) videoEncoders.av1 = `${av1} (ffmpeg ${ffmpegVersion})`;
    if (caps.libx264) videoEncoders.h264 = `libx264 (ffmpeg ${ffmpegVersion})`;
  }
  const audit = (current: Manifest | null) =>
    runProjectRules({
      plan: finalPlan,
      manifest: current,
      videoEncoders,
      unavailableCodecs: missingCodecs,
      encoders: engine.encoders(),
      outputHash,
      sourceExists: async (source) =>
        (await stat(resolve(projectRoot, ...source.split("/"))).catch(() => null))?.isFile() ??
        false,
    });

  if (!options.execute) {
    // A dry run stays read-only: the analysis cache is used but not persisted.
    return {
      plan: finalPlan,
      cache,
      findings: await audit(manifest),
      unsupported,
      svgs,
      videos,
      notes,
    };
  }

  const result = await runPlan(finalPlan, {
    projectRoot,
    engine,
    fs,
    manifest,
    ...(options.force !== undefined ? { force: options.force } : {}),
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onItemStart ? { onItemStart: options.onItemStart } : {}),
    ...(options.onOutputDone ? { onOutputDone: options.onOutputDone } : {}),
    ...(options.onItemDone ? { onItemDone: options.onItemDone } : {}),
    ...(options.videoEngine
      ? {
          video: {
            engine: options.videoEngine,
            ...(options.videoConcurrency !== undefined
              ? { concurrency: options.videoConcurrency }
              : {}),
            ...(options.needsFfmpeg ? { needsFfmpeg: options.needsFfmpeg } : {}),
          },
        }
      : {}),
    ...(options.onVideoItemStart ? { onVideoItemStart: options.onVideoItemStart } : {}),
    ...(options.onVideoProgress ? { onVideoProgress: options.onVideoProgress } : {}),
    ...(options.onVideoOutputDone ? { onVideoOutputDone: options.onVideoOutputDone } : {}),
    ...(options.onVideoItemDone ? { onVideoItemDone: options.onVideoItemDone } : {}),
  });

  const updated = updateManifest(manifest, finalPlan, result, {
    bytecut: options.toolVersion,
    ...engine.versions(),
  });

  // Only touch the manifest when its content changed, so an unchanged run is a no-op in git.
  // `tools` is informational and ignored for that comparison.
  const touched =
    result.items.some((i) => i.status !== "skipped") ||
    (result.videos ?? []).some((v) => v.status !== "skipped");
  if (touched) {
    const next = serializeManifest(updated);
    const previous = manifest ? serializeManifest({ ...manifest, tools: updated.tools }) : null;
    if (next !== previous) await fs.writeOutput(MANIFEST_FILE, Buffer.from(next));
  }
  await analysisCache.save(fs);

  return {
    plan: finalPlan,
    cache,
    findings: await audit(updated),
    unsupported,
    svgs,
    videos,
    notes,
    result,
  };
}

async function readManifest(fs: SafeFs): Promise<Manifest | null> {
  const data = await fs.readOutput(MANIFEST_FILE);
  return data ? parseManifest(data.toString("utf8")) : null;
}

/**
 * What is degraded on this machine for the videos in the plan. The plan itself does not
 * change with the machine, so this is where "AV1 will be skipped" gets said (§4).
 */
export function videoNotes(
  plan: Plan,
  caps: { libsvtav1: boolean; libaomAv1: boolean; libx264: boolean; libvmaf: boolean } | null,
  needsFfmpeg?: string,
): string[] {
  const videos = plan.videos ?? [];
  if (videos.length === 0) return [];
  const notes: string[] = [];
  if (!caps) {
    notes.push(
      `ffmpeg not found: ${videos.length} video file${videos.length === 1 ? "" : "s"} cannot be processed (${needsFfmpeg ?? "install ffmpeg"}). Images are unaffected.`,
    );
    return notes;
  }
  if (!caps.libsvtav1 && !caps.libaomAv1) {
    notes.push(
      "No AV1 encoder (libsvtav1 / libaom-av1): AV1 outputs will be skipped; H.264 and posters are still produced.",
    );
  } else if (!caps.libsvtav1) {
    notes.push("libsvtav1 not found: AV1 will be encoded with libaom-av1, which is much slower.");
  }
  if (!caps.libx264) {
    notes.push("libx264 not found: H.264 fallback outputs will be skipped.");
  }
  if (!caps.libvmaf) {
    notes.push("libvmaf not available: using the preset's fixed quality (no VMAF search).");
  }
  return notes;
}

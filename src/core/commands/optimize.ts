import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runProjectRules } from "../audit/run.js";
import type { Finding } from "../audit/types.js";
import { AnalysisCache } from "../cache/store.js";
import { classify } from "../classify/classify.js";
import type { ImageAnalysis, ImageEngine } from "../engines/types.js";
import { runPlan, type ItemResult, type RunResult } from "../execute/run.js";
import { SafeFs } from "../fs-safe.js";
import { sha256 } from "../hash.js";
import { checkCache, type CacheState } from "../manifest/cache.js";
import { parseManifest, serializeManifest } from "../manifest/io.js";
import { MANIFEST_FILE, type Manifest } from "../manifest/types.js";
import { updateManifest } from "../manifest/update.js";
import { buildPlan, DEFAULT_PUBLIC_PATH, type PresetChoice } from "../plan/build.js";
import type { Plan } from "../plan/types.js";
import { getImagePreset } from "../presets/index.js";
import { collectAssets } from "../scan/collect.js";

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
  /** Write outputs. When false only the plan and findings are produced. */
  execute: boolean;
  force?: boolean;
  concurrency?: number;
  signal?: AbortSignal;
  onItemDone?(result: ItemResult, done: number, total: number): void;
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
  /** Present only when `execute` was true. */
  result?: RunResult;
}

export function engineFingerprint(engine: ImageEngine): string {
  const v = engine.versions();
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
    sourceFiles = plan.items.map((i) => resolve(projectRoot, ...i.source.split("/")));
  } else {
    const found = await collectAssets(options.inputs ?? [], { cwd: projectRoot, outDir });
    sourceFiles = found.files;
    sourceDirs = found.sourceDirs;
    unsupported = found.unsupported;
    svgs = found.svgs;
    videos = found.videos;
    if (found.files.length === 0) {
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
      };
    }
  }

  const fs = await SafeFs.create({ projectRoot, outDir, sourceFiles, sourceDirs });

  // Analysis (a pixel decode) is cached by content hash; a cold run just computes it.
  const analysisCache = await AnalysisCache.load(fs, engineFingerprint(engine));
  const analyze = async (data: Buffer, digest: string): Promise<ImageAnalysis> => {
    const cached = analysisCache.getAnalysis(digest);
    if (cached) return cached;
    const fresh = await engine.analyze(data);
    analysisCache.setAnalysis(digest, fresh);
    return fresh;
  };

  const override = options.presetOverride ? getImagePreset(options.presetOverride) : null;
  const choosePreset = (source: string, analysis: ImageAnalysis): PresetChoice => {
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
    plan = await buildPlan({
      files: sourceFiles,
      projectRoot,
      outDir,
      ...(options.staticRoot !== undefined ? { staticRoot: options.staticRoot } : {}),
      ...(options.publicPath ? { publicPath: options.publicPath } : {}),
      choosePreset,
      engine,
      analyze,
      readSource: (path) => fs.readSource(path),
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

  const audit = (current: Manifest | null) =>
    runProjectRules({
      plan: finalPlan,
      manifest: current,
      encoders: engine.encoders(),
      outputHash,
      sourceExists: async (source) =>
        (await stat(resolve(projectRoot, ...source.split("/"))).catch(() => null))?.isFile() ??
        false,
    });

  if (!options.execute) {
    // A dry run stays read-only: the analysis cache is used but not persisted.
    return { plan: finalPlan, cache, findings: await audit(manifest), unsupported, svgs, videos };
  }

  const result = await runPlan(finalPlan, {
    projectRoot,
    engine,
    fs,
    manifest,
    ...(options.force !== undefined ? { force: options.force } : {}),
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onItemDone ? { onItemDone: options.onItemDone } : {}),
  });

  const updated = updateManifest(manifest, finalPlan, result, {
    bytecut: options.toolVersion,
    ...engine.versions(),
  });

  // Only touch the manifest when its content changed, so an unchanged run is a no-op in git.
  // `tools` is informational and ignored for that comparison.
  const touched = result.items.some((i) => i.status !== "skipped");
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
    result,
  };
}

async function readManifest(fs: SafeFs): Promise<Manifest | null> {
  const data = await fs.readOutput(MANIFEST_FILE);
  return data ? parseManifest(data.toString("utf8")) : null;
}

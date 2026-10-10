import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { estimateItem } from "../audit/estimate.js";
import { ALL_RULES } from "../audit/rules/index.js";
import { savingOf } from "../audit/rules/helpers.js";
import { sortFindings } from "../audit/run.js";
import type {
  AuditContext,
  Budgets,
  Finding,
  ImageFacts,
  RuleSettings,
  SvgFacts,
} from "../audit/types.js";
import { AnalysisCache } from "../cache/store.js";
import { classify } from "../classify/classify.js";
import type { ImageAnalysis, ImageEngine } from "../engines/types.js";
import type { SvgEngine } from "../engines/svg.js";
import { SafeFs } from "../fs-safe.js";
import { sha256 } from "../hash.js";
import { checkCache } from "../manifest/cache.js";
import { parseManifest } from "../manifest/io.js";
import { MANIFEST_FILE, type Manifest } from "../manifest/types.js";
import { ANIMATED_GIF_REASON, buildPlan } from "../plan/build.js";
import { getImagePreset } from "../presets/index.js";
import { collectAssets } from "../scan/collect.js";
import { scanReferences } from "../scan/references.js";
import { toPosix } from "../posix.js";
import { relative } from "node:path";
import { engineFingerprint } from "./optimize.js";

export interface AuditOptions {
  projectRoot: string;
  engine: ImageEngine;
  svgEngine: SvgEngine;
  inputs: string[];
  outDir: string;
  staticRoot: string;
  /** Per-rule severity and options; absent rules use their defaults. */
  settings?: RuleSettings;
  budgets?: Budgets;
  ffmpeg: { found: boolean; installHint: string };
  /** Persist the analysis cache inside outDir (default true). */
  persistCache?: boolean;
  /** Scan project text files for references (default true). */
  scanReferences?: boolean;
  /** Per-file preset by source path; wins over the classifier (the TUI's per-file choice). */
  presetOverrides?: Record<string, string>;
  /** Coarse progress for a UI; `total` is the number of raster files. */
  onProgress?(event: { phase: AuditPhase; done: number; total: number }): void;
}

/** One scanned raster file, as the TUI lists it. */
export interface FileSummary {
  source: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
  /** Preset the classifier chose; "-" for files that can't be processed. */
  preset: string;
  reason: string;
  /** Up-to-date outputs already exist. */
  covered: boolean;
  estimatedBytes: number | null;
  savingsBytes: number | null;
  plannedOutputs: number;
  /** Why the file can't be processed (animated, corrupt, ...). */
  skipped?: string;
}

export type AuditPhase = "scan" | "analyze" | "estimate" | "references";

export interface AuditReport {
  findings: Finding[];
  /** Every raster file scanned, sorted by path. */
  files: FileSummary[];
  counts: { images: number; svgs: number; videos: number; skipped: number };
  totals: {
    /** Bytes of every raster source scanned. */
    sourceBytes: number;
    /** Best-per-file estimate of what optimizing the not-yet-optimized images would save. */
    potentialSavingsBytes: number;
    /** Images whose outputs are already up to date. */
    optimizedImages: number;
  };
  notes: string[];
}

export async function audit(options: AuditOptions): Promise<AuditReport> {
  const { projectRoot, engine, svgEngine } = options;
  const outDir = resolve(projectRoot, options.outDir);
  const notes: string[] = [];

  const found = await collectAssets(options.inputs, { cwd: projectRoot, outDir });
  const fs = await SafeFs.create({
    projectRoot,
    outDir,
    sourceFiles: [...found.files, ...found.svgs],
    sourceDirs: found.sourceDirs,
  });

  const cache = await AnalysisCache.load(fs, `${engineFingerprint(engine)};${svgEngine.version()}`);
  const manifestData = await fs.readOutput(MANIFEST_FILE);
  const manifest: Manifest | null = manifestData
    ? parseManifest(manifestData.toString("utf8"))
    : null;

  const total = found.files.length;
  let analyzed = 0;
  options.onProgress?.({ phase: "scan", done: 0, total });
  const analyze = async (data: Buffer, digest: string): Promise<ImageAnalysis> => {
    let result = cache.getAnalysis(digest);
    if (!result) {
      result = await engine.analyze(data);
      cache.setAnalysis(digest, result);
    }
    options.onProgress?.({ phase: "analyze", done: ++analyzed, total });
    return result;
  };

  const plan = await buildPlan({
    files: found.files,
    projectRoot,
    outDir,
    staticRoot: options.staticRoot,
    choosePreset: (source, analysis) => {
      const forced = options.presetOverrides?.[source];
      if (forced) {
        return { preset: getImagePreset(forced), reason: `set to ${forced} for this file` };
      }
      const verdict = classify(source, analysis);
      return {
        preset: getImagePreset(verdict.preset),
        reason: verdict.reason,
        confidence: verdict.confidence,
      };
    },
    engine,
    analyze,
    readSource: (path) => fs.readSource(path),
  });

  const outputHash = async (path: string) => {
    const data = await fs.readOutput(path);
    return data ? sha256(data) : null;
  };
  const absoluteOf = (source: string) => resolve(projectRoot, ...source.split("/"));

  const images: ImageFacts[] = [];
  const skipped: AuditContext["skipped"] = [];
  let estimated = 0;
  for (const item of plan.items) {
    options.onProgress?.({ phase: "estimate", done: estimated++, total });
    if (item.skip) {
      skipped.push({
        source: item.source,
        bytes: item.sourceBytes,
        reason: item.skip.reason,
        animatedGif: item.skip.reason.startsWith(ANIMATED_GIF_REASON),
      });
      continue;
    }
    const data = absoluteOf(item.source);
    const estimate = await estimateItem(item, () => fs.readSource(data), { engine, cache });
    images.push({
      source: item.source,
      bytes: item.sourceBytes,
      sha256: item.sourceSha256,
      // The analysis is cached by hash, so this is a lookup, not a second decode.
      analysis: cache.getAnalysis(item.sourceSha256)!,
      classification: {
        preset: item.preset as "photo" | "hero" | "icon",
        confidence: item.classification?.confidence ?? "low",
        reason: item.classification?.reason ?? "",
      },
      item,
      cache: await checkCache(item, manifest?.sources[item.source], outputHash),
      estimate,
    });
  }

  const svgs: SvgFacts[] = [];
  for (const path of found.svgs) {
    const buffer = await fs.readSource(path);
    const digest = sha256(buffer);
    let analysis = cache.getSvg(digest);
    if (!analysis) {
      analysis = svgEngine.analyze(buffer.toString("utf8"));
      cache.setSvg(digest, analysis);
    }
    svgs.push({
      source: toPosix(relative(projectRoot, path)),
      bytes: buffer.byteLength,
      sha256: digest,
      ...analysis,
    });
  }
  svgs.sort((a, b) => (a.source < b.source ? -1 : 1));

  let references: Set<string> | null = null;
  if (options.scanReferences !== false) {
    const scan = await scanReferences({ cwd: projectRoot, outDir });
    references = scan.names;
    if (scan.truncated) {
      notes.push("Reference scan hit its size limit; project/unreferenced may over-report.");
    }
  }

  const settings = options.settings ?? {};
  const settingFor = (id: string) => {
    const raw = settings[id];
    return Array.isArray(raw)
      ? { severity: raw[0], options: raw[1] }
      : { severity: raw, options: {} };
  };

  const ctx: AuditContext = {
    plan,
    manifest,
    encoders: engine.encoders(),
    outputHash,
    sourceExists: async (source) =>
      (await stat(absoluteOf(source)).catch(() => null))?.isFile() ?? false,
    images,
    skipped,
    svgs,
    videos: found.videos.map((v) => toPosix(relative(projectRoot, v))),
    references,
    budgets: options.budgets ?? {},
    ffmpeg: options.ffmpeg,
    options: (id) => settingFor(id).options,
  };

  const findings: Finding[] = [];
  for (const rule of ALL_RULES) {
    const { severity } = settingFor(rule.id);
    if (severity === "off") continue;
    for (const finding of await rule.check(ctx)) {
      findings.push(severity ? { ...finding, severity } : finding);
    }
  }

  if (found.videos.length > 0) {
    notes.push(
      `${found.videos.length} video file${found.videos.length === 1 ? "" : "s"} found but not analysed: video auditing arrives in M5.`,
    );
  }

  if (options.persistCache !== false) await cache.save(fs);

  const potential = images.reduce(
    (sum, image) => sum + (image.cache.kind === "hit" ? 0 : (savingOf(image) ?? 0)),
    0,
  );
  const files: FileSummary[] = [
    ...images.map((image): FileSummary => ({
      source: image.source,
      bytes: image.bytes,
      width: image.analysis.width,
      height: image.analysis.height,
      format: image.analysis.format,
      preset: image.item.preset,
      reason: image.classification.reason,
      covered: image.cache.kind === "hit",
      estimatedBytes: image.estimate?.best.bytes ?? null,
      savingsBytes: savingOf(image) ?? null,
      plannedOutputs: image.item.outputs.length,
    })),
    ...plan.items
      .filter((i) => i.skip)
      .map((i): FileSummary => ({
        source: i.source,
        bytes: i.sourceBytes,
        width: i.sourceWidth,
        height: i.sourceHeight,
        format: "-",
        preset: "-",
        reason: "",
        covered: false,
        estimatedBytes: null,
        savingsBytes: null,
        plannedOutputs: 0,
        skipped: i.skip!.reason,
      })),
  ].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));

  return {
    findings: sortFindings(findings),
    files,
    counts: {
      images: images.length,
      svgs: svgs.length,
      videos: found.videos.length,
      skipped: skipped.length,
    },
    totals: {
      sourceBytes:
        images.reduce((s, i) => s + i.bytes, 0) + skipped.reduce((s, i) => s + i.bytes, 0),
      potentialSavingsBytes: potential,
      optimizedImages: images.filter((i) => i.cache.kind === "hit").length,
    },
    notes,
  };
}

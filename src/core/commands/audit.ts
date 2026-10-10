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
import { BUILTIN_POLICY, rootPreset, type PresetPolicy } from "../presets/catalog.js";
import { getImagePreset } from "../presets/index.js";
import { matchesGlob } from "../config/glob.js";
import { collectAssets } from "../scan/collect.js";
import { scanReferences } from "../scan/references.js";
import { toPosix } from "../posix.js";
import { relative } from "node:path";
import { engineFingerprint } from "./optimize.js";
import { withVideos } from "./plan-media.js";
import { checkVideoCache } from "../manifest/cache.js";
import { estimateVideo } from "../audit/estimate-video.js";
import { isFastStart } from "../video/probe.js";
import type { VideoEngine } from "../video/types.js";
import type { VideoFacts } from "../audit/types.js";
import { classifyVideo, type VideoClassification } from "../classify/video.js";
import { basename, dirname, extname } from "node:path";

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
  /** ffmpeg-backed engine, or null when ffmpeg is missing. Videos are then listed, not analysed. */
  videoEngine?: VideoEngine | null;
  /** What to install when ffmpeg is missing, e.g. "install ffmpeg with: brew install ffmpeg". */
  needsFfmpeg?: string;
  /** Per-file preset by source path; wins over the classifier (the TUI's per-file choice). */
  presetOverrides?: Record<string, string>;
  /** Presets from the config and its `assets` rules; absent means the built-ins and the classifier. */
  policy?: PresetPolicy;
  /** .gitignore-style patterns for files left out of directory scans (config `exclude`). */
  exclude?: string[];
  /** Globs of sources whose findings are dropped (config `audit.ignore`). */
  ignore?: string[];
  /** Coarse progress for a UI; `total` is the number of raster files. */
  onProgress?(event: { phase: AuditPhase; done: number; total: number }): void;
}

/** One scanned raster file, as the TUI lists it. */
export interface FileSummary {
  source: string;
  /** `video` for videos and animated GIFs; absent means image. */
  kind?: "image" | "video";
  durationSec?: number;
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
  /** Videos that need ffmpeg and so were listed but not analysed (§4). */
  unprobed: Array<{ source: string; bytes: number }>;
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

  const found = await collectAssets(options.inputs, {
    cwd: projectRoot,
    outDir,
    ...(options.exclude ? { exclude: options.exclude } : {}),
  });
  const policy = options.policy ?? BUILTIN_POLICY;
  const fs = await SafeFs.create({
    projectRoot,
    outDir,
    sourceFiles: [...found.files, ...found.svgs, ...found.videos],
    sourceDirs: found.sourceDirs,
  });

  const videoVersions = options.videoEngine ? await options.videoEngine.versions() : {};
  const cache = await AnalysisCache.load(
    fs,
    `${engineFingerprint(engine, videoVersions)};${svgEngine.version()}`,
  );
  const manifestData = await fs.readOutput(MANIFEST_FILE);
  const manifest: Manifest | null = manifestData
    ? parseManifest(manifestData.toString("utf8"))
    : null;

  const total = found.files.length + found.videos.length;
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

  const imagePlan = await buildPlan({
    files: found.files,
    projectRoot,
    outDir,
    staticRoot: options.staticRoot,
    choosePreset: (source, analysis) => {
      const forced = options.presetOverrides?.[source];
      if (forced) {
        return {
          preset: getImagePreset(forced, policy.catalog),
          reason: `set to ${forced} for this file`,
        };
      }
      const matched = policy.assetFor(source);
      const assetPreset = matched ? policy.catalog.image[matched.preset] : undefined;
      if (matched && assetPreset) {
        return {
          preset: assetPreset,
          reason: `set to ${matched.preset} by assets "${matched.pattern}"`,
          confidence: "high",
        };
      }
      const verdict = classify(source, analysis);
      return {
        preset: getImagePreset(verdict.preset, policy.catalog),
        reason: verdict.reason,
        confidence: verdict.confidence,
      };
    },
    engine,
    analyze,
    readSource: (path) => fs.readSource(path),
  });

  const needsFfmpeg = options.needsFfmpeg ?? "install ffmpeg";
  const plan = await withVideos(imagePlan, {
    projectRoot,
    staticRoot: options.staticRoot,
    videoFiles: found.videos,
    videoEngine: options.videoEngine ?? null,
    needsFfmpeg,
    presetOverrides: options.presetOverrides,
    policy,
    cache,
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
        // Rules reason about the built-in a custom preset descends from.
        preset: rootPreset(policy.catalog, item.preset) as "photo" | "hero" | "icon",
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

  // Videos and animated GIFs: probed (cached by hash), then estimated with real sample encodes.
  const videoFacts: VideoFacts[] = [];
  const unprobed: Array<{ source: string; bytes: number }> = [];
  const siblingImages = new Set([
    ...images.map((i) => i.source),
    ...skipped.map((i) => i.source),
    ...plan.items.map((i) => i.source),
  ]);
  const missingCodecs = new Set<string>();
  const caps = options.videoEngine ? await options.videoEngine.capabilities() : null;
  if (caps) {
    if (!caps.libsvtav1 && !caps.libaomAv1) missingCodecs.add("av1");
    if (!caps.libx264) missingCodecs.add("h264");
  }
  let probed = 0;
  for (const item of plan.videos ?? []) {
    options.onProgress?.({ phase: "estimate", done: probed++, total });
    if (item.skip) {
      if (item.skip.reason.startsWith("needs ffmpeg")) {
        unprobed.push({ source: item.source, bytes: item.sourceBytes });
      } else {
        skipped.push({
          source: item.source,
          bytes: item.sourceBytes,
          reason: item.skip.reason,
          animatedGif: false,
        });
      }
      continue;
    }
    const probe = cache.getVideoProbe(item.sourceSha256);
    if (!probe) continue;
    const absolute = absoluteOf(item.source);
    const cacheState = await checkVideoCache(
      item,
      manifest?.videos[item.source],
      outputHash,
      missingCodecs,
    );
    const isGif = extname(item.source).toLowerCase() === ".gif";
    const covered = cacheState.kind === "hit";
    const estimate =
      covered || !options.videoEngine
        ? null
        : await estimateVideo(
            item,
            {
              engine: options.videoEngine,
              cache,
              ffmpegVersion: videoVersions.ffmpeg ?? "unknown",
            },
            absolute,
          );
    const stem = `${dirname(item.source) === "." ? "" : `${dirname(item.source)}/`}${basename(item.source, extname(item.source))}`;
    const hasPoster = ["jpg", "jpeg", "png", "webp", "avif"].some(
      (ext) =>
        siblingImages.has(`${stem}.${ext}`) ||
        siblingImages.has(`${stem}-poster.${ext}`) ||
        siblingImages.has(`${stem}_poster.${ext}`),
    );
    videoFacts.push({
      source: item.source,
      bytes: item.sourceBytes,
      sha256: item.sourceSha256,
      probe,
      faststart: isGif ? null : await isFastStart(absolute).catch(() => null),
      classification: isGif
        ? { preset: "gif-to-video", confidence: "high", reason: "animated GIF" }
        : {
            // What the plan chose (a per-file or `assets` choice included), as its built-in.
            preset: rootPreset(policy.catalog, item.preset) as VideoClassification["preset"],
            confidence:
              item.classification?.confidence ?? classifyVideo(item.source, probe).confidence,
            reason: item.classification?.reason ?? classifyVideo(item.source, probe).reason,
          },
      item,
      cache: cacheState,
      estimate,
      hasPoster,
      isGif,
    });
  }

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

  const videoEncoders: Partial<Record<"av1" | "h264", string>> = {};
  if (caps && videoVersions.ffmpeg) {
    const av1 = caps.libsvtav1 ? "libsvtav1" : caps.libaomAv1 ? "libaom-av1" : null;
    if (av1) videoEncoders.av1 = `${av1} (ffmpeg ${videoVersions.ffmpeg})`;
    if (caps.libx264) videoEncoders.h264 = `libx264 (ffmpeg ${videoVersions.ffmpeg})`;
  }

  const ctx: AuditContext = {
    plan,
    manifest,
    videoEncoders,
    unavailableCodecs: missingCodecs,
    encoders: engine.encoders(),
    outputHash,
    sourceExists: async (source) =>
      (await stat(absoluteOf(source)).catch(() => null))?.isFile() ?? false,
    images,
    skipped,
    svgs,
    videos: videoFacts,
    unprobed: unprobed.map((u) => ({ ...u, reason: `needs ffmpeg: ${needsFfmpeg}` })),
    references,
    budgets: options.budgets ?? {},
    ffmpeg: options.ffmpeg,
    options: (id) => settingFor(id).options,
  };

  // `audit.ignore`: what is deliberately left alone raises no findings and is not listed to fix.
  const ignorePatterns = options.ignore ?? [];
  const isIgnored = (source: string) => ignorePatterns.some((p) => matchesGlob(p, source));
  const ignoreSources = (all: Finding[]) =>
    ignorePatterns.length === 0 ? all : all.filter((f) => !f.source || !isIgnored(f.source));

  const findings: Finding[] = [];
  for (const rule of ALL_RULES) {
    const { severity } = settingFor(rule.id);
    if (severity === "off") continue;
    for (const finding of await rule.check(ctx)) {
      findings.push(severity ? { ...finding, severity } : finding);
    }
  }

  if (unprobed.length > 0) {
    notes.push(
      `${unprobed.length} video file${unprobed.length === 1 ? "" : "s"} need ffmpeg to be analysed: ${needsFfmpeg}`,
    );
  }
  if (caps && !caps.libsvtav1 && !caps.libaomAv1 && videoFacts.length > 0) {
    notes.push("No AV1 encoder installed: video estimates use H.264 only.");
  }

  if (options.persistCache !== false) await cache.save(fs);

  const potentialImages = images.reduce(
    (sum, image) => sum + (image.cache.kind === "hit" ? 0 : (savingOf(image) ?? 0)),
    0,
  );
  const potentialVideos = videoFacts.reduce(
    (sum, v) =>
      sum +
      (v.cache.kind === "hit" ? 0 : Math.max(0, v.bytes - (v.estimate?.best.bytes ?? v.bytes))),
    0,
  );
  const potential = potentialImages + potentialVideos;
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
    ...videoFacts.map((v): FileSummary => ({
      source: v.source,
      bytes: v.bytes,
      width: v.probe.width,
      height: v.probe.height,
      format: v.isGif ? "gif" : v.probe.videoCodec,
      kind: "video",
      durationSec: v.probe.durationSec,
      preset: v.item.preset,
      reason: v.classification.reason,
      covered: v.cache.kind === "hit",
      estimatedBytes: v.estimate?.best.bytes ?? null,
      savingsBytes: v.estimate ? Math.max(0, v.bytes - v.estimate.best.bytes) : null,
      plannedOutputs: v.item.outputs.length,
    })),
    ...unprobed.map((u): FileSummary => ({
      source: u.source,
      bytes: u.bytes,
      width: 0,
      height: 0,
      format: "-",
      kind: "video",
      preset: "-",
      reason: "",
      covered: false,
      estimatedBytes: null,
      savingsBytes: null,
      plannedOutputs: 0,
      skipped: `needs ffmpeg: ${needsFfmpeg}`,
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
    findings: sortFindings(ignoreSources(findings)),
    unprobed,
    files: files.filter((f) => !isIgnored(f.source)),
    counts: {
      images: images.length,
      svgs: svgs.length,
      videos: videoFacts.length + unprobed.length,
      skipped: skipped.length,
    },
    totals: {
      sourceBytes:
        images.reduce((s, i) => s + i.bytes, 0) +
        videoFacts.reduce((s, v) => s + v.bytes, 0) +
        unprobed.reduce((s, u) => s + u.bytes, 0) +
        skipped.reduce((s, i) => s + i.bytes, 0),
      potentialSavingsBytes: potential,
      optimizedImages:
        images.filter((i) => i.cache.kind === "hit").length +
        videoFacts.filter((v) => v.cache.kind === "hit").length,
    },
    notes,
  };
}

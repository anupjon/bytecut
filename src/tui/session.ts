import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { audit, type AuditPhase } from "../core/commands/audit.js";
import { optimize } from "../core/commands/optimize.js";
import type { ImageEngine } from "../core/engines/types.js";
import type { SvgEngine } from "../core/engines/svg.js";
import type { VideoEngine } from "../core/video/types.js";
import { BytecutError } from "../core/errors.js";
import type {
  ItemResult,
  OutputResult,
  RunResult,
  VideoItemResult,
  VideoOutputResult,
} from "../core/execute/run.js";
import { SafeFs } from "../core/fs-safe.js";
import type { SelectedScorer } from "../core/quality/select.js";
import { toPosix } from "../core/posix.js";
import { parseManifest } from "../core/manifest/io.js";
import { MANIFEST_FILE } from "../core/manifest/types.js";
import { startCompareServer, type CompareServer } from "../core/compare/index.js";
import { buildSnippet, originalUrl, snippetFormatFor } from "../core/snippets/index.js";
import { readFile } from "node:fs/promises";
import type { ProjectInfo } from "../core/scan/detect.js";
import {
  applyChoices,
  canRewrite,
  isEmpty,
  renderChoicesSnippet,
  renderConfig,
} from "../core/config/choices.js";
import type { Choices } from "../core/config/choices.js";
import { loadConfig } from "../core/config/load.js";
import { resolveConfig, resolveConfigData, type ResolvedConfig } from "../core/config/resolve.js";
import { parseConfig } from "../core/config/schema.js";
import { writeConfigFile } from "../core/fs-safe.js";
import { buildModel, type Model } from "./model.js";
import type { Review, ReviewItem, SaveOutcome } from "./state.js";

export interface SessionOptions {
  projectRoot: string;
  engine: ImageEngine;
  svgEngine: SvgEngine;
  project: ProjectInfo;
  /** The merged config; absent means zero-config for `project`. */
  config?: ResolvedConfig;
  /** Paths scanned, relative to the project root. */
  inputs: string[];
  toolVersion: string;
  ffmpeg: { found: boolean; installHint: string };
  concurrency?: number;
  /** Creates the quality scorer for outputs with a perceptual target. */
  makeScorer?: (fs: SafeFs) => Promise<SelectedScorer>;
  videoEngine?: VideoEngine | null;
  needsFfmpeg?: string;
}

export interface RunHandlers {
  onItemStart(source: string): void;
  onOutput(source: string, output: OutputResult | VideoOutputResult): void;
  onItemDone(result: ItemResult | VideoItemResult): void;
  /** Encode progress of one video output, 0..1. */
  onProgress?(source: string, path: string, fraction: number): void;
}

/**
 * Everything the TUI asks of the core, in one place and free of React, so the UI can be
 * tested against a fake and the core is only ever called the way the CLI calls it.
 */
export interface Session {
  scan(
    outDir: string,
    presets: Record<string, string>,
    onProgress: (p: { phase: AuditPhase; done: number; total: number }) => void,
  ): Promise<{ model: Model; files: string[] }>;
  review(sources: string[], presets: Record<string, string>, outDir: string): Promise<Review>;
  run(
    sources: string[],
    presets: Record<string, string>,
    outDir: string,
    handlers: RunHandlers,
    signal: AbortSignal,
  ): Promise<RunResult>;
  /** The markup for an optimized file, or why there is none. */
  snippet(
    source: string,
    outDir: string,
  ): Promise<{ code: string; hints: string[] } | { error: string }>;
  /**
   * Starts a localhost before/after page for an optimized file and returns its URL. The
   * server lives until `stop()`; the page is never opened for the user.
   */
  compare(source: string, outDir: string): Promise<{ url: string } | { error: string }>;
  /** Stops every compare server this session started. */
  stop(): Promise<void>;
  /**
   * Makes choices permanent. A JSON (or missing) config is written; a TOML or TS config is
   * code the user owns, so it is left alone and the lines to add are returned instead.
   */
  saveChoices(choices: Choices): Promise<SaveOutcome>;
  /** Null when `outDir` is acceptable, otherwise the reason it is not (§6.5). */
  validateOutDir(outDir: string, sources: string[]): Promise<string | null>;
}

export function createSession(options: SessionOptions): Session {
  const { projectRoot, engine } = options;
  const compareServers: CompareServer[] = [];
  // Replaced after a save, so the next scan sees what was just written.
  let config = options.config ?? resolveConfigData({}, options.project, null);
  const common = (outDir: string) => ({
    projectRoot,
    engine,
    toolVersion: options.toolVersion,
    videoEngine: options.videoEngine ?? null,
    ...(options.needsFfmpeg ? { needsFfmpeg: options.needsFfmpeg } : {}),
    outDir,
    staticRoot: config.project.staticRoot,
    publicPath: config.project.publicPath,
    policy: config.policy,
    exclude: config.exclude,
    ...(config.placeholder ? { placeholder: config.placeholder } : {}),
    ...(options.makeScorer ? { makeScorer: options.makeScorer } : {}),
  });

  return {
    async scan(outDir, presets, onProgress) {
      const report = await audit({
        projectRoot,
        engine,
        svgEngine: options.svgEngine,
        inputs: options.inputs,
        outDir,
        staticRoot: config.project.staticRoot,
        policy: config.policy,
        exclude: config.exclude,
        ignore: config.auditIgnore,
        settings: config.rules,
        budgets: config.budgets,
        ffmpeg: options.ffmpeg,
        videoEngine: options.videoEngine ?? null,
        ...(options.needsFfmpeg ? { needsFfmpeg: options.needsFfmpeg } : {}),
        persistCache: true,
        presetOverrides: presets,
        onProgress,
      });
      return { model: buildModel(report), files: report.files.map((f) => f.source) };
    },

    async review(sources, presets, outDir) {
      const outcome = await optimize({
        ...common(outDir),
        inputs: sources,
        presetOverrides: presets,
        execute: false,
      });
      const videoItems: ReviewItem[] = (outcome.plan.videos ?? []).map((item): ReviewItem => {
        if (item.skip) {
          return {
            source: item.source,
            preset: item.preset,
            state: "skipped",
            outputs: 0,
            note: item.skip.reason,
          };
        }
        const unchanged = outcome.cache.get(item.source)?.kind === "hit";
        return {
          source: item.source,
          preset: item.preset,
          state: unchanged ? "unchanged" : "encode",
          outputs: item.outputs.length,
        };
      });
      const items: ReviewItem[] = [
        ...outcome.plan.items.map((item): ReviewItem => {
          if (item.skip) {
            return {
              source: item.source,
              preset: item.preset,
              state: "skipped",
              outputs: 0,
              note: item.skip.reason,
            };
          }
          const unchanged = outcome.cache.get(item.source)?.kind === "hit";
          return {
            source: item.source,
            preset: item.preset,
            state: unchanged ? "unchanged" : "encode",
            outputs: item.outputs.length,
          };
        }),
        ...videoItems,
      ];
      return {
        plan: outcome.plan,
        items,
        willEncode: items.filter((i) => i.state === "encode").length,
        unchanged: items.filter((i) => i.state === "unchanged").length,
        outputs: items.filter((i) => i.state === "encode").reduce((n, i) => n + i.outputs, 0),
        findings: outcome.findings,
      };
    },

    async run(sources, presets, outDir, handlers, signal) {
      const outcome = await optimize({
        ...common(outDir),
        inputs: sources,
        presetOverrides: presets,
        execute: true,
        signal,
        concurrency: options.concurrency ?? config.concurrency ?? 2,
        onItemStart: handlers.onItemStart,
        onOutputDone: handlers.onOutput,
        onItemDone: (result) => handlers.onItemDone(result),
        onVideoItemStart: handlers.onItemStart,
        onVideoOutputDone: handlers.onOutput,
        onVideoItemDone: (result) => handlers.onItemDone(result),
        ...(handlers.onProgress ? { onVideoProgress: handlers.onProgress } : {}),
      });
      if (!outcome.result) {
        throw new BytecutError("BAD_ARGUMENTS", "Nothing was run.");
      }
      return outcome.result;
    },

    async snippet(source, outDir) {
      let text: string;
      try {
        text = await readFile(resolve(projectRoot, outDir, MANIFEST_FILE), "utf8");
      } catch {
        return { error: `No manifest in ${outDir} yet: run the optimizer first.` };
      }
      const manifest = parseManifest(text);
      const built = buildSnippet(
        manifest,
        { source, originalUrl: originalUrl(source, config.project.staticRoot) },
        { format: snippetFormatFor(config.project) },
      );
      if (!built) return { error: `${source} has not been optimized yet.` };
      return { code: built.code, hints: built.hints };
    },

    async compare(source, outDir) {
      let text: string;
      try {
        text = await readFile(resolve(projectRoot, outDir, MANIFEST_FILE), "utf8");
      } catch {
        return { error: `No manifest in ${outDir} yet: run the optimizer first.` };
      }
      try {
        const server = await startCompareServer({
          projectRoot,
          outDir,
          manifest: parseManifest(text),
          source,
        });
        compareServers.push(server);
        return { url: server.url };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },

    async stop() {
      await Promise.all(compareServers.splice(0).map((s) => s.close()));
    },

    async saveChoices(choices) {
      if (isEmpty(choices)) return { kind: "nothing" };
      try {
        const loaded = await loadConfig(projectRoot);
        if (loaded && !canRewrite(loaded.format)) {
          return {
            kind: "manual",
            file: loaded.name,
            snippet: renderChoicesSnippet(loaded.format, choices),
          };
        }
        const next = applyChoices(loaded?.raw ?? {}, choices);
        const file = loaded?.name ?? "bytecut.config.json";
        // Never write something the loader would then refuse.
        parseConfig(next, file);
        await writeConfigFile(projectRoot, file, renderConfig("json", next));
        config = await resolveConfig(projectRoot, await loadConfig(projectRoot));
        return { kind: "written", file, created: loaded === null };
      } catch (error) {
        return { kind: "error", message: error instanceof Error ? error.message : String(error) };
      }
    },

    async validateOutDir(outDir, sources) {
      const absolute = resolve(projectRoot, outDir);
      try {
        await SafeFs.create({
          projectRoot,
          outDir: absolute,
          sourceFiles: sources.map((s) => resolve(projectRoot, ...s.split("/"))),
          sourceDirs: [],
        });
        // The folder may not exist yet; it must not be a file.
        const info = await stat(absolute).catch(() => null);
        if (info && !info.isDirectory()) return `${outDir} is a file, not a folder`;
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
}

/** Display form of an output folder: relative to the project root, POSIX. */
export function displayOutDir(projectRoot: string, outDir: string): string {
  const rel = relative(projectRoot, resolve(projectRoot, outDir));
  return toPosix(rel === "" ? "." : rel);
}

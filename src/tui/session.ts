import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { audit, type AuditPhase } from "../core/commands/audit.js";
import { optimize } from "../core/commands/optimize.js";
import type { ImageEngine } from "../core/engines/types.js";
import type { SvgEngine } from "../core/engines/svg.js";
import { BytecutError } from "../core/errors.js";
import type { ItemResult, OutputResult, RunResult } from "../core/execute/run.js";
import { SafeFs } from "../core/fs-safe.js";
import { toPosix } from "../core/posix.js";
import type { ProjectInfo } from "../core/scan/detect.js";
import { buildModel, type Model } from "./model.js";
import type { Review, ReviewItem } from "./state.js";

export interface SessionOptions {
  projectRoot: string;
  engine: ImageEngine;
  svgEngine: SvgEngine;
  project: ProjectInfo;
  /** Paths scanned, relative to the project root. */
  inputs: string[];
  toolVersion: string;
  ffmpeg: { found: boolean; installHint: string };
  concurrency?: number;
}

export interface RunHandlers {
  onItemStart(source: string): void;
  onOutput(source: string, output: OutputResult): void;
  onItemDone(result: ItemResult): void;
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
  /** Null when `outDir` is acceptable, otherwise the reason it is not (§6.5). */
  validateOutDir(outDir: string, sources: string[]): Promise<string | null>;
}

export function createSession(options: SessionOptions): Session {
  const { projectRoot, engine, project } = options;
  const common = (outDir: string) => ({
    projectRoot,
    engine,
    toolVersion: options.toolVersion,
    outDir,
    staticRoot: project.staticRoot,
    publicPath: project.publicPath,
  });

  return {
    async scan(outDir, presets, onProgress) {
      const report = await audit({
        projectRoot,
        engine,
        svgEngine: options.svgEngine,
        inputs: options.inputs,
        outDir,
        staticRoot: project.staticRoot,
        ffmpeg: options.ffmpeg,
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
      const items: ReviewItem[] = outcome.plan.items.map((item): ReviewItem => {
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
        concurrency: options.concurrency ?? 2,
        onItemStart: handlers.onItemStart,
        onOutputDone: handlers.onOutput,
        onItemDone: (result) => handlers.onItemDone(result),
      });
      if (!outcome.result) {
        throw new BytecutError("BAD_ARGUMENTS", "Nothing was run.");
      }
      return outcome.result;
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

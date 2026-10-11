import { readFile } from "node:fs/promises";
import { extname, posix, relative, resolve } from "node:path";
import { classify } from "../classify/classify.js";
import { classifyVideo } from "../classify/video.js";
import type { ImageEngine } from "../engines/types.js";
import { toPosix } from "../posix.js";
import { formatBytes } from "../units.js";
import { mirroredDir, outputWidths } from "../plan/build.js";
import { plannedVideoOutputs } from "../plan/video.js";
import type { ImagePreset } from "../presets/photo.js";
import { getVideoPreset, type VideoPreset } from "../presets/video.js";
import type { VideoEngine } from "../video/types.js";
import { matchesGlob } from "./glob.js";
import type { ResolvedConfig } from "./resolve.js";

const RASTER = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);
const VIDEO = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);

export type Decision =
  | { by: "flag"; reason: string }
  | { by: "assets"; pattern: string; reason: string }
  | { by: "classifier"; reason: string; confidence: string }
  | { by: "unavailable"; reason: string };

export interface Explanation {
  source: string;
  kind: "image" | "video" | "svg" | "unsupported";
  decision: Decision;
  /** Null when no preset could be decided (an unsupported file, or a video without ffprobe). */
  preset: string | null;
  /** The preset and what it extends, outermost built-in first. */
  chain: string[];
  /** Settings the config changed on top of the base, by name. */
  changedBy: string[];
  resolved: ImagePreset | VideoPreset | null;
  /** Output paths this file would produce, relative to outDir; empty when unknown. */
  outputs: string[];
  /** Project-level context for the same decision. */
  outDir: string;
  publicPath: string;
  excluded: boolean;
  auditIgnored: boolean;
}

export interface ExplainOptions {
  projectRoot: string;
  file: string;
  config: ResolvedConfig;
  engine: ImageEngine;
  videoEngine: VideoEngine | null;
  /** `--preset`: what a flag would do, shown on top of the config. */
  presetFlag?: string | undefined;
}

/**
 * Walks the same precedence the planner uses (flag, assets, classifier) and says which
 * layer decided and what the resolved preset is. Reads the file; never writes anything.
 */
export async function explainFile(options: ExplainOptions): Promise<Explanation> {
  const { config, projectRoot } = options;
  const absolute = resolve(projectRoot, options.file);
  const source = toPosix(relative(projectRoot, absolute));
  const ext = extname(source).toLowerCase();
  const { catalog } = config;

  const base = {
    source,
    outDir: config.project.outDir,
    publicPath: config.project.publicPath,
    excluded: false,
    auditIgnored: config.auditIgnore.some((p) => matchesGlob(p, source)),
  };
  const none = (kind: Explanation["kind"], reason: string): Explanation => ({
    ...base,
    kind,
    decision: { by: "unavailable", reason },
    preset: null,
    chain: [],
    changedBy: [],
    resolved: null,
    outputs: [],
  });

  if (ext === ".svg") return none("svg", "SVG output is not implemented yet");
  const isVideo = VIDEO.has(ext);
  if (!isVideo && !RASTER.has(ext))
    return none("unsupported", `${ext || "this"} is not a supported type`);

  const matched = config.policy.assetFor(source);
  const detail = (preset: string) => ({
    chain: catalog.origin[preset]?.chain ?? [preset],
    changedBy: catalog.origin[preset]?.overrides ?? [],
  });

  // Decide by precedence for a given kind; `kindOf` says which catalog a name must be in.
  const pick = (
    kind: "image" | "video",
    classifier: () => { preset: string; reason: string; confidence: string } | null,
  ): { preset: string | null; decision: Decision } => {
    const known = (name: string) => (kind === "image" ? catalog.image[name] : catalog.video[name]);
    if (options.presetFlag) {
      if (!known(options.presetFlag)) {
        return {
          preset: null,
          decision: {
            by: "unavailable",
            reason: `--preset ${options.presetFlag} is not a ${kind} preset`,
          },
        };
      }
      return {
        preset: options.presetFlag,
        decision: { by: "flag", reason: `forced with --preset ${options.presetFlag}` },
      };
    }
    if (matched && known(matched.preset)) {
      return {
        preset: matched.preset,
        decision: {
          by: "assets",
          pattern: matched.pattern,
          reason: `matched assets "${matched.pattern}"`,
        },
      };
    }
    const verdict = classifier();
    if (!verdict) {
      return {
        preset: null,
        decision: {
          by: "unavailable",
          reason: "classifying a video needs ffprobe, which was not found",
        },
      };
    }
    return {
      preset: verdict.preset,
      decision: { by: "classifier", reason: verdict.reason, confidence: verdict.confidence },
    };
  };

  if (!isVideo) {
    const data = await readFile(absolute);
    const analysis = await options.engine.analyze(data);
    if (!(analysis.animated && analysis.format === "gif")) {
      const { preset, decision } = pick("image", () => classify(source, analysis));
      const resolved = preset ? catalog.image[preset]! : null;
      const dir = mirroredDir(source, config.project.staticRoot);
      const name = posix.basename(source, posix.extname(source));
      const outputs = resolved
        ? outputWidths(resolved, analysis.width, analysis.height).flatMap((w) =>
            resolved.formats.map((f) => posix.join(dir, `${name}-${w}.${f}`)),
          )
        : [];
      return {
        ...base,
        kind: "image",
        decision,
        preset,
        ...(preset ? detail(preset) : { chain: [], changedBy: [] }),
        resolved,
        outputs,
      };
    }
  }

  // Videos and animated GIFs.
  const probe = options.videoEngine
    ? await options.videoEngine.probe(absolute).catch(() => null)
    : null;
  const isGif = ext === ".gif";
  const { preset, decision } = pick("video", () => {
    if (isGif) return { preset: "gif-to-video", reason: "animated GIF", confidence: "high" };
    return probe ? classifyVideo(source, probe) : null;
  });
  const resolved: VideoPreset | null = preset ? (getVideoPreset(preset, catalog) ?? null) : null;
  return {
    ...base,
    kind: "video",
    decision,
    preset,
    ...(preset ? detail(preset) : { chain: [], changedBy: [] }),
    resolved,
    outputs:
      resolved && probe
        ? plannedVideoOutputs(source, config.project.staticRoot, resolved, probe).map((o) => o.path)
        : [],
  };
}

export function formatExplanation(e: Explanation): string {
  const lines: string[] = [e.source];
  lines.push(`  type:     ${e.kind}`);
  if (e.preset === null) {
    lines.push(`  preset:   none (${e.decision.reason})`);
  } else {
    const how =
      e.decision.by === "assets"
        ? `assets rule "${e.decision.pattern}"`
        : e.decision.by === "flag"
          ? "the --preset flag"
          : e.decision.by === "classifier"
            ? `classifier, ${e.decision.confidence} confidence: ${e.decision.reason}`
            : e.decision.reason;
    lines.push(`  preset:   ${e.preset}  (from ${how})`);
    if (e.chain.length > 1 || e.changedBy.length > 0) {
      lines.push(`  extends:  ${e.chain.join(" → ")}`);
      if (e.changedBy.length > 0) lines.push(`  changed:  ${e.changedBy.join(", ")}`);
    }
  }
  const r = e.resolved;
  if (r && "widths" in r) {
    lines.push(
      r.maxEdge !== undefined
        ? `  size:     longest side up to ${r.maxEdge}px (width if landscape, height if portrait; never above the source)`
        : `  widths:   ${r.widths.join(", ")} (never above the source)`,
    );
    lines.push(`  formats:  ${r.formats.join(", ")}`);
    for (const f of r.formats) {
      const lossless = r.lossless ? ", lossless" : "";
      lines.push(
        `  ${f}:     quality ${r.encoders[f].quality}, effort ${r.encoders[f].effort}${lossless}`,
      );
    }
    lines.push(`  priority: ${r.priority ? "yes (fetchpriority=high, never lazy)" : "no"}`);
    if (r.search) {
      const parts = [`ssimulacra2 >= ${r.search.target}`];
      if (r.search.maxBytes !== undefined) {
        parts.push(
          `at most ${formatBytes(r.search.maxBytes)} per file, quality may fall to a score of ${r.search.floor}`,
        );
      }
      lines.push(
        `  search:   ${parts.join("; ")} (quality is found per image; lossless outputs are exact)`,
      );
    }
  } else if (r) {
    lines.push(`  codecs:   ${r.codecs.join(", ")}`);
    lines.push(`  audio:    ${r.audio === "strip" ? "removed" : "kept"}`);
    lines.push(
      `  cap:      ${r.maxWidth ? `${r.maxWidth}px wide` : "no width cap"}, ${r.maxFps ? `${r.maxFps} fps` : "no fps cap"}`,
    );
    lines.push(`  crf:      av1 ${r.crf.av1}, h264 ${r.crf.h264}`);
    if (r.search) {
      lines.push(
        `  search:   ${r.search.metric} >= ${r.search.target} on the worst of 3 sampled clips (crf above is the starting point)`,
      );
      if (r.search.maxBytes !== undefined) {
        lines.push(
          `  size cap: at most ${formatBytes(r.search.maxBytes)} per file; quality may fall to ${r.search.metric} ${r.search.floor}, then the width steps down (never below half)`,
        );
      }
    }
  }
  if (e.outputs.length > 0) {
    lines.push(`  outputs:  ${e.outDir}/`);
    for (const o of e.outputs) lines.push(`    ${o}`);
  }
  if (e.auditIgnored)
    lines.push("  note:     matched audit.ignore, so audit raises no findings for it");
  return lines.join("\n");
}

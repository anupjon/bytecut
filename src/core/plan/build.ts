import { posix, relative } from "node:path";
import type { ImageAnalysis, ImageEngine } from "../engines/types.js";
import { BytecutError } from "../errors.js";
import { sha256 } from "../hash.js";
import { toPosix } from "../posix.js";
import type { ImageFormat, ImagePreset } from "../presets/photo.js";
import type { Plan, PlanItem, PlannedOutput } from "./types.js";

/**
 * Preset widths that fit the source, never upscaling. A source narrower than the largest
 * preset width also gets one output at its native width, so small images aren't dropped.
 */
export function targetWidths(presetWidths: number[], sourceWidth: number): number[] {
  const widths = presetWidths.filter((w) => w <= sourceWidth);
  const largest = Math.max(...presetWidths);
  if (sourceWidth < largest && !widths.includes(sourceWidth)) widths.push(sourceWidth);
  return [...new Set(widths)].sort((a, b) => a - b);
}

/**
 * The output widths for a source under a preset. With `maxEdge` (the default) that is one
 * width: the longest side is capped, so a landscape image is `maxEdge` wide and a portrait
 * one is `maxEdge` tall with its width in proportion (rounded down, so the height never
 * exceeds the cap). An image already within the cap keeps its native size (§6.7).
 */
export function outputWidths(
  preset: Pick<ImagePreset, "widths" | "maxEdge">,
  sourceWidth: number,
  sourceHeight: number,
): number[] {
  if (preset.maxEdge === undefined) return targetWidths(preset.widths, sourceWidth);
  const longest = Math.max(sourceWidth, sourceHeight);
  if (longest <= preset.maxEdge) return [sourceWidth];
  return [Math.max(1, Math.floor((sourceWidth * preset.maxEdge) / longest))];
}

/**
 * The formats to write for one source. `jpg` cannot hold transparency or be lossless, so where
 * the preset asks for it and the source needs either, that entry becomes `png` instead (§6.9
 * keeps alpha; §6.8 keeps ambiguous PNGs lossless). The other formats handle both natively.
 */
export function formatsFor(
  preset: Pick<ImagePreset, "formats" | "lossless">,
  analysis: Pick<ImageAnalysis, "format" | "alphaUsed">,
  confidence: "high" | "medium" | "low" | undefined,
): ImageFormat[] {
  // A PNG whose content the classifier could not tell apart is not turned into a lossy JPEG.
  const ambiguousPng = analysis.format === "png" && confidence === "low";
  const needsPng = analysis.alphaUsed || preset.lossless === true || ambiguousPng;
  const out = preset.formats.map((f) => (f === "jpg" && needsPng ? "png" : f));
  return [...new Set(out)];
}

/**
 * `<mirrored dir>` for a source: relative to the static root when inside it, so the output
 * URL parallels how the original is served; otherwise relative to the project root.
 */
export function mirroredDir(source: string, staticRoot: string): string {
  const dir = posix.dirname(source);
  if (staticRoot !== "." && staticRoot !== "") {
    if (dir === staticRoot) return "";
    if (dir.startsWith(`${staticRoot}/`)) return dir.slice(staticRoot.length + 1);
  }
  return dir === "." ? "" : dir;
}

export const DEFAULT_PUBLIC_PATH = "/_bytecut";

/** Prefix of the skip reason for animated GIFs; the audit uses it to tell them apart. */
export const ANIMATED_GIF_REASON = "animated GIF";

export interface PresetChoice {
  preset: ImagePreset;
  /** Why this preset was chosen; shown in dry-run output. */
  reason: string;
  confidence?: "high" | "medium" | "low";
}

export interface BuildPlanOptions {
  files: string[];
  projectRoot: string;
  outDir: string;
  /** Folder served at the site root, relative to the project root (`.` for the root itself). */
  staticRoot?: string;
  /** URL prefix for outputs; defaults to /_bytecut. */
  publicPath?: string;
  choosePreset(source: string, analysis: ImageAnalysis): PresetChoice;
  engine: ImageEngine;
  readSource(path: string): Promise<Buffer>;
  /** Lets callers cache analysis by content hash. Defaults to `engine.analyze`. */
  analyze?(data: Buffer, sha256: string): Promise<ImageAnalysis>;
}

export async function buildPlan(options: BuildPlanOptions): Promise<Plan> {
  const items: PlanItem[] = [];
  const claimed = new Map<string, string>();
  const staticRoot = options.staticRoot ?? ".";
  const analyze = options.analyze ?? ((data: Buffer) => options.engine.analyze(data));

  // Sorted by POSIX path so the plan is identical on every OS.
  const files = options.files
    .map((file) => ({ file, source: toPosix(relative(options.projectRoot, file)) }))
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));

  for (const { file, source } of files) {
    if (source.startsWith("../") || source === "..") {
      throw new BytecutError(
        "SOURCE_OUTSIDE_PROJECT",
        `${file} is outside the project root (${options.projectRoot}); run bytecut from a parent folder.`,
      );
    }

    const data = await options.readSource(file);
    const digest = sha256(data);
    const base: Omit<PlanItem, "outputs" | "preset"> = {
      source,
      sourceBytes: data.byteLength,
      sourceSha256: digest,
      sourceWidth: 0,
      sourceHeight: 0,
    };

    let analysis: ImageAnalysis;
    try {
      analysis = await analyze(data, digest);
    } catch {
      items.push({
        ...base,
        preset: "-",
        outputs: [],
        skip: { reason: "unreadable or corrupt image" },
      });
      continue;
    }
    const sized = { ...base, sourceWidth: analysis.width, sourceHeight: analysis.height };

    if (analysis.format === "other") {
      items.push({
        ...sized,
        preset: "-",
        outputs: [],
        skip: { reason: "unsupported image format" },
      });
      continue;
    }
    if (analysis.animated) {
      const reason =
        analysis.format === "gif"
          ? `${ANIMATED_GIF_REASON} (video conversion arrives with ffmpeg support in M5)`
          : "animated image";
      items.push({ ...sized, preset: "-", outputs: [], skip: { reason } });
      continue;
    }

    const choice = options.choosePreset(source, analysis);
    const { preset } = choice;

    // Mirrored layout: <mirrored source dir>/<basename>/<basename>-<width>.<ext>
    const dir = mirroredDir(source, staticRoot);
    const name = posix.basename(source, posix.extname(source));
    const outputs: PlannedOutput[] = [];
    for (const width of outputWidths(preset, analysis.width, analysis.height)) {
      for (const format of formatsFor(preset, analysis, choice.confidence)) {
        // Conservative (§6.8): without a flat-art verdict a PNG's WebP stays lossless; AVIF
        // lossless is slow and rarely wins, so it stays lossy unless the preset demands it.
        // PNG output is lossless by nature.
        const lossless =
          format === "png" || (preset.lossless ?? (analysis.format === "png" && format === "webp"));
        const path = posix.join(dir, name, `${name}-${width}.${format}`);
        const owner = claimed.get(path);
        if (owner !== undefined) {
          throw new BytecutError(
            "OUTPUT_COLLISION",
            `${source} and ${owner} would both write ${path}. Rename one of them.`,
          );
        }
        claimed.set(path, source);
        outputs.push({
          path,
          format,
          width,
          lossless,
          ...preset.encoders[format],
          // A lossless output is exact; there is nothing to search for.
          ...(preset.search && !lossless ? { search: { ...preset.search } } : {}),
        });
      }
    }
    items.push({
      ...sized,
      preset: preset.name,
      classification: {
        reason: choice.reason,
        ...(choice.confidence ? { confidence: choice.confidence } : {}),
      },
      outputs,
    });
  }

  return {
    version: 1,
    outDir: toPosix(relative(options.projectRoot, options.outDir)) || ".",
    publicPath: options.publicPath ?? DEFAULT_PUBLIC_PATH,
    items,
  };
}

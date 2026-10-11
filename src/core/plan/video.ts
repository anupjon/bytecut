import { stat } from "node:fs/promises";
import { posix, relative } from "node:path";
import { classifyVideo } from "../classify/video.js";
import { BytecutError } from "../errors.js";
import { sha256File } from "../hash.js";
import { toPosix } from "../posix.js";
import { BUILTIN_POLICY, type PresetPolicy } from "../presets/catalog.js";
import { getVideoPreset, type VideoPreset } from "../presets/video.js";
import { outputWidth } from "../video/args.js";
import type { VideoProbe } from "../video/probe.js";
import type { VideoEngine } from "../video/types.js";
import { mirroredDir } from "./build.js";
import type { PlannedMediaOutput, VideoPlanItem } from "./types.js";

export interface BuildVideoPlanOptions {
  /** Absolute paths of videos and animated GIFs. */
  files: string[];
  projectRoot: string;
  staticRoot?: string;
  /** Null when there is no ffmpeg: every file is then listed as "needs ffmpeg". */
  engine: VideoEngine | null;
  /** Shown when ffmpeg is missing, e.g. the OS install command. */
  needsFfmpeg: string;
  /** Per-file preset override by source path. */
  presetOverrides?: Record<string, string>;
  /** Presets from the config; absent means the built-ins and the classifier. */
  policy?: PresetPolicy;
  /** Output paths already claimed by image items, to detect collisions. */
  claimed?: Set<string>;
  /** Lets callers cache probes by content hash. Defaults to `engine.probe`. */
  probe?(absolutePath: string, sha256: string): Promise<VideoProbe | null>;
}

function skipped(
  source: string,
  bytes: number,
  sha: string,
  reason: string,
  extra: Partial<VideoPlanItem> = {},
): VideoPlanItem {
  return {
    source,
    sourceBytes: bytes,
    sourceSha256: sha,
    sourceWidth: 0,
    sourceHeight: 0,
    durationSec: 0,
    fps: 0,
    hasAudio: false,
    videoCodec: "unknown",
    preset: "-",
    outputs: [],
    skip: { reason },
    ...extra,
  };
}

/** Output paths for one source under a preset; shared with the audit's planning. */
export function plannedVideoOutputs(
  source: string,
  staticRoot: string,
  preset: VideoPreset,
  probe: VideoProbe,
): PlannedMediaOutput[] {
  const dir = mirroredDir(source, staticRoot);
  const name = posix.basename(source, posix.extname(source));
  const width = outputWidth(probe.width, preset.maxWidth);
  const outputs: PlannedMediaOutput[] = [];
  for (const codec of preset.codecs) {
    outputs.push({
      role: "video",
      path: posix.join(dir, name, `${name}-${width}.${codec}.mp4`),
      codec,
      width,
      crf: preset.crf[codec],
      speed: preset.speed[codec],
      maxWidth: preset.maxWidth,
      maxFps: preset.maxFps,
      audio: preset.audio,
      audioBitrate: preset.audioBitrate,
      ...(preset.search ? { search: { ...preset.search } } : {}),
    });
  }
  outputs.push({
    role: "poster",
    path: posix.join(dir, name, `${name}-poster.avif`),
    format: "avif",
    width,
    quality: preset.poster.quality,
    effort: preset.poster.effort,
    at: preset.poster.at,
  });
  return outputs;
}

export async function buildVideoItems(options: BuildVideoPlanOptions): Promise<VideoPlanItem[]> {
  const staticRoot = options.staticRoot ?? ".";
  const claimed = options.claimed ?? new Set<string>();
  const items: VideoPlanItem[] = [];

  const files = options.files
    .map((file) => ({ file, source: toPosix(relative(options.projectRoot, file)) }))
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));

  const caps = options.engine ? await options.engine.capabilities() : null;

  for (const { file, source } of files) {
    if (source.startsWith("../") || source === "..") {
      throw new BytecutError(
        "SOURCE_OUTSIDE_PROJECT",
        `${file} is outside the project root (${options.projectRoot}); run bytecut from a parent folder.`,
      );
    }
    const [info, sha] = await Promise.all([stat(file), sha256File(file)]);

    if (!options.engine || !caps) {
      items.push(skipped(source, info.size, sha, `needs ffmpeg: ${options.needsFfmpeg}`));
      continue;
    }

    let probe: VideoProbe | null;
    try {
      probe = options.probe ? await options.probe(file, sha) : await options.engine.probe(file);
    } catch {
      items.push(skipped(source, info.size, sha, "could not be read by ffprobe"));
      continue;
    }
    if (!probe || probe.width === 0 || probe.height === 0) {
      items.push(skipped(source, info.size, sha, "no video stream"));
      continue;
    }

    const media = {
      sourceWidth: probe.width,
      sourceHeight: probe.height,
      durationSec: probe.durationSec,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      videoCodec: probe.videoCodec,
    };

    const policy = options.policy ?? BUILTIN_POLICY;
    const override = options.presetOverrides?.[source];
    const forced = override ? getVideoPreset(override, policy.catalog) : undefined;
    const matched = policy.assetFor(source);
    const byAssets = matched ? getVideoPreset(matched.preset, policy.catalog) : undefined;
    let preset: VideoPreset;
    let why: { reason: string; confidence?: "high" | "medium" | "low" };
    if (forced) {
      preset = forced;
      why = { reason: `set to ${forced.name} for this file` };
    } else if (byAssets && matched) {
      preset = byAssets;
      why = {
        reason: `set to ${byAssets.name} by assets "${matched.pattern}"`,
        confidence: "high",
      };
    } else if (posix.extname(source).toLowerCase() === ".gif") {
      preset = getVideoPreset("gif-to-video", policy.catalog)!;
      why = { reason: "animated GIF", confidence: "high" };
    } else {
      const verdict = classifyVideo(source, probe);
      preset = getVideoPreset(verdict.preset, policy.catalog)!;
      why = { reason: verdict.reason, confidence: verdict.confidence };
    }

    const outputs = plannedVideoOutputs(source, staticRoot, preset, probe);
    for (const out of outputs) {
      if (claimed.has(out.path)) {
        throw new BytecutError(
          "OUTPUT_COLLISION",
          `${source} would write ${out.path}, which another source already writes. Rename one of them.`,
        );
      }
      claimed.add(out.path);
    }
    items.push({
      source,
      sourceBytes: info.size,
      sourceSha256: sha,
      ...media,
      preset: preset.name,
      classification: why,
      outputs,
    });
  }
  return items;
}

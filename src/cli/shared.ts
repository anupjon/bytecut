import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { installHint, resolveBinary } from "../core/ffmpeg/index.js";
import { loadConfig } from "../core/config/load.js";
import { resolveConfig, type ResolvedConfig } from "../core/config/resolve.js";
import type { ProjectInfo } from "../core/scan/detect.js";
import { createFfmpegVideoEngine } from "../core/video/ffmpeg-engine.js";
import type { VideoEngine } from "../core/video/types.js";
import type { SafeFs } from "../core/fs-safe.js";
import { selectScorer, type SelectedScorer } from "../core/quality/select.js";
import { isFile, readOsReleaseId, run } from "./system.js";
import { availableParallelism } from "node:os";

export interface Discovery {
  projectRoot: string;
  project: ProjectInfo;
  /** What will be scanned; empty when there is nothing to scan. */
  scanInputs: string[];
  /** Output folder, relative to the project root. */
  outDir: string;
  /** The config merged over detection; `project` is already this with config applied. */
  config: ResolvedConfig;
}

/** The `--config <path>` flag every project command accepts. */
export const configArg = {
  config: {
    type: "string",
    description: "Path to a config file (default: bytecut.config.{ts,js,json,toml} in the project)",
  },
} as const;

/** Zero-config discovery shared by every command: framework, folders to scan, output folder. */
export async function discover(
  inputs: string[],
  outDirArg?: string,
  configPath?: string,
): Promise<Discovery> {
  const projectRoot = process.cwd();
  const config = await resolveConfig(projectRoot, await loadConfig(projectRoot, configPath));
  const { project } = config;
  const scanInputs =
    inputs.length > 0 ? inputs : project.include.filter((p) => existsSync(resolve(projectRoot, p)));
  return { projectRoot, project, scanInputs, outDir: outDirArg ?? project.outDir, config };
}

export function ffmpegStatus(config?: { ffmpegPath?: string | undefined }): {
  found: boolean;
  installHint: string;
} {
  const resolved = resolveBinary(
    "ffmpeg",
    { env: process.env, platform: process.platform, config: config?.ffmpegPath },
    { isFile },
  );
  return { found: resolved.found, installHint: installHint(process.platform, readOsReleaseId()) };
}

export function noAssetsMessage(command: string, project: ProjectInfo): string {
  return `bytecut${command ? ` ${command}` : ""}: no asset folder found (looked for ${project.include.join(", ")}). Pass files or folders.`;
}

/**
 * The ffmpeg-backed engine, resolved flag → env → PATH (§4). It is always returned: a missing
 * ffmpeg is reported by `capabilities()` returning null, so callers handle one code path.
 */
export function createVideoEngine(
  flags: { ffmpeg?: string | undefined; ffprobe?: string | undefined } = {},
  config: { ffmpegPath?: string | undefined; ffprobePath?: string | undefined } = {},
): VideoEngine {
  return createFfmpegVideoEngine({
    ffmpegFlag: flags.ffmpeg,
    ffprobeFlag: flags.ffprobe,
    ffmpegConfig: config.ffmpegPath,
    ffprobeConfig: config.ffprobePath,
    env: process.env,
    platform: process.platform,
    deps: { isFile },
    run,
  });
}

/**
 * How a run gets its quality scorer: a native ssimulacra2 if one is named or on PATH,
 * otherwise the built-in WebAssembly one. Created only when a search actually needs it.
 */
export function makeScorerFactory(
  flag: string | undefined,
  config: { ssimulacra2Path?: string | undefined } = {},
): (fs: SafeFs) => Promise<SelectedScorer> {
  return async (fs) => {
    const sharp = (await import("sharp")).default;
    return selectScorer({
      flag,
      config: config.ssimulacra2Path,
      env: process.env,
      platform: process.platform,
      deps: { isFile },
      fs,
      run,
      size: Math.max(1, Math.min(4, availableParallelism() - 1)),
      toPng: async (image) =>
        new Uint8Array(
          await sharp(image.data, {
            raw: { width: image.width, height: image.height, channels: 3 },
          })
            .png()
            .toBuffer(),
        ),
    });
  };
}

/** "install ffmpeg with: …" text for the OS we are on. */
export function ffmpegInstallText(): string {
  return `install ffmpeg with: ${installHint(process.platform, readOsReleaseId())}`;
}

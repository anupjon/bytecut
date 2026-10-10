import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { installHint, resolveBinary } from "../core/ffmpeg/index.js";
import { detectProject, type ProjectInfo } from "../core/scan/detect.js";
import { createFfmpegVideoEngine } from "../core/video/ffmpeg-engine.js";
import type { VideoEngine } from "../core/video/types.js";
import { isFile, readOsReleaseId, run } from "./system.js";

export interface Discovery {
  projectRoot: string;
  project: ProjectInfo;
  /** What will be scanned; empty when there is nothing to scan. */
  scanInputs: string[];
  /** Output folder, relative to the project root. */
  outDir: string;
}

/** Zero-config discovery shared by every command: framework, folders to scan, output folder. */
export async function discover(inputs: string[], outDirArg?: string): Promise<Discovery> {
  const projectRoot = process.cwd();
  const project = await detectProject(projectRoot);
  const scanInputs =
    inputs.length > 0 ? inputs : project.include.filter((p) => existsSync(resolve(projectRoot, p)));
  return { projectRoot, project, scanInputs, outDir: outDirArg ?? project.outDir };
}

export function ffmpegStatus(): { found: boolean; installHint: string } {
  const resolved = resolveBinary(
    "ffmpeg",
    { env: process.env, platform: process.platform },
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
): VideoEngine {
  return createFfmpegVideoEngine({
    ffmpegFlag: flags.ffmpeg,
    ffprobeFlag: flags.ffprobe,
    env: process.env,
    platform: process.platform,
    deps: { isFile },
    run,
  });
}

/** "install ffmpeg with: …" text for the OS we are on. */
export function ffmpegInstallText(): string {
  return `install ffmpeg with: ${installHint(process.platform, readOsReleaseId())}`;
}

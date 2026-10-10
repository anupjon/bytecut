import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { installHint, resolveBinary } from "../core/ffmpeg/index.js";
import { detectProject, type ProjectInfo } from "../core/scan/detect.js";
import { isFile, readOsReleaseId } from "./system.js";

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

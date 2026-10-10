import { delimiter, dirname, join } from "node:path";
import type { BinaryName, ResolvedBinary } from "./types.js";

export interface ResolveOptions {
  /** `--ffmpeg` / `--ffprobe` flag value. */
  flag?: string | undefined;
  /** `ffmpegPath` / `ffprobePath` from bytecut.config. */
  config?: string | undefined;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** Directory of the resolved ffmpeg; only used when resolving ffprobe. */
  ffmpegDir?: string | undefined;
}

export interface ResolveDeps {
  isFile(path: string): boolean;
}

const ENV_VAR: Record<BinaryName, string> = {
  ffmpeg: "BYTECUT_FFMPEG",
  ffprobe: "BYTECUT_FFPROBE",
};

function executableNames(name: BinaryName, platform: NodeJS.Platform, env: ResolveOptions["env"]) {
  if (platform !== "win32") return [name];
  const exts = (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
  return [name, ...exts.map((ext) => name + ext.toLowerCase())];
}

/**
 * Order: flag → env → config → (ffprobe only: ffmpeg's directory) → PATH.
 * An explicitly configured path that doesn't exist is reported as not found rather than
 * falling through, so a typo never silently selects a different binary.
 */
export function resolveBinary(
  name: BinaryName,
  options: ResolveOptions,
  deps: ResolveDeps,
): ResolvedBinary {
  const explicit = [
    ["flag", options.flag],
    ["env", options.env[ENV_VAR[name]]],
    ["config", options.config],
  ] as const;

  for (const [source, value] of explicit) {
    if (value === undefined || value === "") continue;
    return deps.isFile(value)
      ? { found: true, path: value, source }
      : { found: false, source, attempted: value };
  }

  const names = executableNames(name, options.platform, options.env);

  if (name === "ffprobe" && options.ffmpegDir) {
    for (const candidate of names) {
      const path = join(options.ffmpegDir, candidate);
      if (deps.isFile(path)) return { found: true, path, source: "ffmpeg-dir" };
    }
  }

  const dirs = (options.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of names) {
      const path = join(dir, candidate);
      if (deps.isFile(path)) return { found: true, path, source: "path" };
    }
  }

  return { found: false, source: null };
}

export function ffmpegDirOf(resolved: ResolvedBinary): string | undefined {
  return resolved.found ? dirname(resolved.path) : undefined;
}

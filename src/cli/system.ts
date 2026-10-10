import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import type { DoctorDeps } from "../core/doctor/report.js";
import { BytecutError } from "../core/errors.js";
import type { Run } from "../core/ffmpeg/index.js";

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `ID=` from /etc/os-release, used to pick the right install command on Linux. */
export function readOsReleaseId(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const text = readFileSync("/etc/os-release", "utf8");
    return /^ID=("?)([^"\n]+)\1$/m.exec(text)?.[2];
  } catch {
    return undefined;
  }
}

const execFileAsync = promisify(execFile);

/** Runs a binary with an argument array, never a shell string (§6.14). */
export const run: Run = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 });
  return { stdout };
};

export function doctorDeps(): DoctorDeps {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    env: process.env,
    osReleaseId: readOsReleaseId(),
    isFile,
    run,
    async loadSharp() {
      try {
        const sharp = (await import("sharp")).default;
        return { version: sharp.versions.sharp ?? "unknown", libvips: sharp.versions.vips };
      } catch (error) {
        throw new BytecutError(
          "SHARP_UNAVAILABLE",
          error instanceof Error ? error.message.split("\n")[0]! : String(error),
          { cause: error },
        );
      }
    },
  };
}

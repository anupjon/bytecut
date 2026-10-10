import { readFileSync, statSync } from "node:fs";

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

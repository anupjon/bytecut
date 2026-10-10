import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { ImageAnalysis } from "../src/core/engines/types.js";

const dirs: string[] = [];

/** Temp directory removed after each test. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bytecut-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

export async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function hashAll(
  dir: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    names.map(async (n) => [n, await sha256(join(dir, n))] as const),
  );
  return Object.fromEntries(entries);
}

/** All file paths under `dir`, POSIX-style and relative, sorted. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) =>
      join(e.parentPath, e.name)
        .slice(dir.length + 1)
        .split("\\")
        .join("/"),
    )
    .sort();
}

/** A plausible photographic JPEG analysis; override what the test cares about. */
export function fakeAnalysis(over: Partial<ImageAnalysis> = {}): ImageAnalysis {
  return {
    width: 2000,
    height: 1000,
    format: "jpeg",
    hasAlpha: false,
    alphaUsed: false,
    animated: false,
    space: "srgb",
    depth: "uchar",
    colorCount: 900,
    sampleSize: 4096,
    metadata: { exif: 0, xmp: 0, iptc: 0, icc: 0, gps: false },
    ...over,
  };
}

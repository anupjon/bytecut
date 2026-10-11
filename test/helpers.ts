import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { buildCatalog } from "../src/core/config/presets.js";
import type { ImageAnalysis } from "../src/core/engines/types.js";
import type { PresetPolicy } from "../src/core/presets/catalog.js";

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

/**
 * Deterministic RGBA pixels for the BlurHash reference vectors. The same function produced
 * `test/fixtures/blurhash-reference.json` with the reference `blurhash` package, so do not
 * change it without regenerating those vectors.
 */
export function vectorPixels(seed: number, w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = (x * 37 + y * 11 + seed * 53) % 256;
      px[i + 1] = (x * 5 + y * 29 + seed * 97) % 256;
      px[i + 2] = (((x * y) % 256) + seed * 17) % 256;
      px[i + 3] = 255;
    }
  }
  return px;
}

/**
 * The built-in presets with AVIF and WebP added, the output set every test written before
 * JPEG became the default expects. Using it also exercises the opt-in path.
 */
export const MODERN_FORMATS = ["avif", "webp"] as const;
export const MODERN_POLICY: PresetPolicy = {
  catalog: buildCatalog({
    photo: { formats: [...MODERN_FORMATS] },
    hero: { formats: [...MODERN_FORMATS] },
    icon: { formats: [...MODERN_FORMATS] },
  }),
  assetFor: () => undefined,
};

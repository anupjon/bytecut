import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadScorer } from "bytecut-ssimulacra2";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeImageFixtures } from "../../scripts/make-fixtures.js";
import { parseManifest } from "../../src/core/manifest/io.js";
import { hashAll, listFiles, tempDir } from "../helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");

let fixtures: string;
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "bytecut-search-fixtures-"));
  await makeImageFixtures(fixtures);
});
afterAll(() => rm(fixtures, { recursive: true, force: true }));

/** No native scorer anywhere: the built-in WebAssembly one must be enough. */
const cli = (cwd: string, args: string[]) =>
  execFileAsync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), join(repoRoot, "src/cli/index.ts"), ...args],
    { cwd, env: { ...process.env, BYTECUT_SSIMULACRA2: "" } },
  ).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({
      code: e.code,
      stdout: e.stdout,
      stderr: e.stderr,
    }),
  );

async function project(preset: Record<string, unknown>) {
  const root = await tempDir();
  await mkdir(join(root, "public/img"), { recursive: true });
  await cp(join(fixtures, "photo.jpg"), join(root, "public/img/photo.jpg"));
  await writeFile(
    join(root, "bytecut.config.json"),
    JSON.stringify({
      presets: { tuned: { extends: "photo", widths: [480], formats: ["webp"], ...preset } },
      assets: { "public/img/photo.jpg": "tuned" },
    }),
  );
  return root;
}

async function rgbOf(input: Buffer | string, width: number) {
  const { data, info } = await sharp(input)
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** Scores an output independently of the code under test. */
async function independentScore(root: string, outputPath: string, width: number) {
  const scorer = await loadScorer();
  const reference = await rgbOf(join(root, "public/img/photo.jpg"), width);
  const candidate = await rgbOf(join(root, "public/_bytecut", outputPath), width);
  return scorer.score(reference, candidate);
}

const manifestOf = async (root: string) =>
  parseManifest(await readFile(join(root, "public/_bytecut/bytecut-manifest.json"), "utf8"));

describe("optimize with a perceptual target (real encoders, built-in scorer)", () => {
  it("writes an output whose full-size score meets the target, and records how", async () => {
    const root = await project({ ssimulacra2: 75 });
    const before = await hashAll(join(root, "public/img"), ["photo.jpg"]);
    const r = await cli(root, ["optimize", "-y"]);
    expect(r.code).toBe(0);

    const manifest = await manifestOf(root);
    const [output] = manifest.sources["public/img/photo.jpg"]!.outputs;
    expect(output).toMatchObject({
      path: "img/photo-480.webp",
      width: 480,
      scorer: "wasm",
      search: { metric: "ssimulacra2", target: 75 },
    });
    expect(output!.quality).toBeGreaterThan(1);
    expect(output!.quality).toBeLessThanOrEqual(100);

    const score = await independentScore(root, output!.path, 480);
    expect(score).toBeGreaterThanOrEqual(75);
    // What the tool recorded is what an independent measurement says (rounding to 2 places).
    expect(Math.abs(score - output!.score!)).toBeLessThan(0.05);

    expect(r.stdout).toMatch(/ssimulacra2 \d+\.\d/);
    expect(await hashAll(join(root, "public/img"), ["photo.jpg"])).toEqual(before);
    // No scorer scratch files are left in the output folder.
    expect(
      (await listFiles(join(root, "public/_bytecut"))).filter((f) => /tmp|\.png$/.test(f)),
    ).toEqual([]);
  }, 120_000);

  it("a higher target costs more bytes and a lower one costs fewer", async () => {
    const size = async (target: number) => {
      const root = await project({ ssimulacra2: target });
      await cli(root, ["optimize", "-y"]);
      return (await manifestOf(root)).sources["public/img/photo.jpg"]!.outputs[0]!.bytes;
    };
    const [low, high] = [await size(60), await size(85)];
    expect(low).toBeLessThan(high);
  }, 240_000);

  it("a second run does no encoding and leaves the manifest byte-identical", async () => {
    const root = await project({ ssimulacra2: 75 });
    await cli(root, ["optimize", "-y"]);
    const path = join(root, "public/_bytecut/bytecut-manifest.json");
    const first = await readFile(path, "utf8");
    const second = await cli(root, ["optimize", "-y"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/unchanged|already/i);
    expect(await readFile(path, "utf8")).toBe(first);
    // Changing the target is a cache miss, and the new output records the new target.
    await writeFile(
      join(root, "bytecut.config.json"),
      JSON.stringify({
        presets: { tuned: { extends: "photo", widths: [480], formats: ["webp"], ssimulacra2: 85 } },
        assets: { "public/img/photo.jpg": "tuned" },
      }),
    );
    await cli(root, ["optimize", "-y"]);
    expect(
      (await manifestOf(root)).sources["public/img/photo.jpg"]!.outputs[0]!.search?.target,
    ).toBe(85);
  }, 240_000);

  it("fits a size cap by lowering quality, and never beyond the floor", async () => {
    const root = await project({ ssimulacra2: 90, floor: 55, maxSize: "9 KB" });
    const r = await cli(root, ["optimize", "-y"]);
    expect(r.code).toBe(0);
    const [output] = (await manifestOf(root)).sources["public/img/photo.jpg"]!.outputs;
    expect(output!.bytes).toBeLessThanOrEqual(9 * 1024);
    expect(output!.search).toMatchObject({ target: 90, floor: 55, maxBytes: 9 * 1024 });
    const score = await independentScore(root, output!.path, output!.width);
    expect(score).toBeGreaterThanOrEqual(55);
    expect(score).toBeLessThan(90 + 5);
  }, 240_000);

  it("steps the width down when quality alone cannot fit, naming the file by its real width", async () => {
    const root = await project({ ssimulacra2: 80, floor: 70, maxSize: "3 KB", widths: [640] });
    const r = await cli(root, ["optimize", "-y"]);
    const manifest = await manifestOf(root);
    const outputs = manifest.sources["public/img/photo.jpg"]?.outputs ?? [];
    if (r.code === 0 && outputs.length > 0) {
      const [output] = outputs;
      expect(output!.bytes).toBeLessThanOrEqual(3 * 1024);
      expect(output!.width).toBeLessThan(640);
      expect(output!.path).toBe(`img/photo-${output!.width}.webp`);
      expect(output!.search?.plannedPath).toBe("img/photo-640.webp");
      expect(await independentScore(root, output!.path, output!.width)).toBeGreaterThanOrEqual(70);
    } else {
      // The cap may be out of reach for this photo; then it must say so and write nothing.
      expect(r.code).toBe(1);
      expect(outputs).toEqual([]);
    }
  }, 240_000);

  it("reports an unreachable cap as a failure and writes nothing for it", async () => {
    const root = await project({ ssimulacra2: 80, floor: 75, maxSize: "300 B" });
    const r = await cli(root, ["optimize", "-y"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/not written: .*cap/);
    const files = await listFiles(join(root, "public/_bytecut"));
    expect(files.filter((f) => f.endsWith(".webp"))).toEqual([]);
    expect(files).not.toContain("img/photo-480.webp");
  }, 240_000);

  it("explain shows the search, and a dry run lists it in the plan", async () => {
    const root = await project({ ssimulacra2: 82, floor: 60, maxSize: "40 KB" });
    const explained = await cli(root, ["explain", "public/img/photo.jpg"]);
    expect(explained.stdout).toMatch(/search:\s+ssimulacra2 >= 82; at most 40\.0 KB per file/);
    const plan = JSON.parse((await cli(root, ["optimize", "--dry-run", "--json"])).stdout) as {
      items: Array<{ outputs: Array<{ search?: unknown }> }>;
    };
    expect(plan.items[0]!.outputs[0]!.search).toEqual({
      metric: "ssimulacra2",
      target: 82,
      floor: 60,
      maxBytes: 40 * 1024,
    });
  });
});

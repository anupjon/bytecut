import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadScorer } from "bytecut-ssimulacra2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasFfmpeg } from "../../scripts/make-fixtures.js";
import { isFile, run } from "../../src/cli/system.js";
import { parseManifest } from "../../src/core/manifest/io.js";
import { createFfmpegVideoEngine } from "../../src/core/video/ffmpeg-engine.js";
import { hashAll, listFiles, tempDir } from "../helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const FFMPEG = await hasFfmpeg();
if (!FFMPEG) console.warn("[bytecut tests] ffmpeg not found: skipping video quality search tests.");
const suite = FFMPEG ? describe : describe.skip;

let fixtures: string;
beforeAll(async () => {
  if (!FFMPEG) return;
  fixtures = await mkdtemp(join(tmpdir(), "bytecut-vsearch-"));
  // Nine seconds, so it is sampled (three 2 s clips) instead of scored whole. Noise keeps the
  // content from being trivially compressible, so quality really does move with the CRF.
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x240:rate=24:duration=9",
    "-vf",
    "noise=alls=18:allf=t,format=yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "14",
    "-an",
    join(fixtures, "long.mp4"),
  ]);
});
afterAll(async () => {
  if (fixtures) await rm(fixtures, { recursive: true, force: true });
});

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
  await mkdir(join(root, "public/media"), { recursive: true });
  await writeFile(join(root, "public/media/long.mp4"), await readFile(join(fixtures, "long.mp4")));
  await writeFile(
    join(root, "bytecut.config.json"),
    JSON.stringify({
      presets: { tuned: { extends: "background-video", codecs: ["h264"], ...preset } },
      assets: { "public/media/long.mp4": "tuned" },
    }),
  );
  return root;
}

const manifestOf = async (root: string) =>
  parseManifest(await readFile(join(root, "public/_bytecut/bytecut-manifest.json"), "utf8"));

const h264Of = async (root: string) => {
  const m = await manifestOf(root);
  return m.videos["public/media/long.mp4"]!.outputs.find((o) => o.codec === "h264")!;
};

suite("video quality search with real ffmpeg and the built-in scorer", () => {
  it("finds a CRF whose output meets the target, measured independently", async () => {
    const root = await project({ ssimulacra2: 70 });
    const before = await hashAll(join(root, "public/media"), ["long.mp4"]);
    const r = await cli(root, ["optimize", "-y"]);
    expect(r.code, r.stderr).toBe(0);

    const out = await h264Of(root);
    expect(out).toMatchObject({ status: "written", scorer: "wasm" });
    expect(out.search).toEqual({ metric: "ssimulacra2", target: 70 });
    expect(out.score).toBeGreaterThanOrEqual(70);
    // Not wildly above the target either: the search spends the budget instead of wasting it.
    expect(out.score!).toBeLessThan(70 + 12);

    // Independent check at times the search did not sample (frames at 1 s, 4 s and 7 s).
    const engine = createFfmpegVideoEngine({
      env: process.env,
      platform: process.platform,
      deps: { isFile },
      run,
    });
    const scorer = await loadScorer();
    const file = join(root, "public/_bytecut", out.path);
    const scores: number[] = [];
    for (const at of [1, 4, 7]) {
      const [ref] = await engine.frames({
        source: join(root, "public/media/long.mp4"),
        startSec: at,
        durationSec: 1,
        count: 1,
        width: 320,
        height: 240,
        pipeline: null,
      });
      const [got] = await engine.frames({
        source: file,
        startSec: at,
        durationSec: 1,
        count: 1,
        width: 320,
        height: 240,
        pipeline: null,
      });
      scores.push(await scorer.score(ref!, got!));
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    // Different frames than the search saw: allow the metric's own spread, not a different regime.
    expect(mean).toBeGreaterThan(70 - 8);

    expect(await hashAll(join(root, "public/media"), ["long.mp4"])).toEqual(before);
    expect((await listFiles(join(root, "public/_bytecut"))).some((f) => f.endsWith(".tmp"))).toBe(
      false,
    );
  }, 180_000);

  it("spends more bytes on a higher target", async () => {
    const low = await project({ ssimulacra2: 55 });
    const high = await project({ ssimulacra2: 80 });
    expect((await cli(low, ["optimize", "-y"])).code).toBe(0);
    expect((await cli(high, ["optimize", "-y"])).code).toBe(0);
    const lo = await h264Of(low);
    const hi = await h264Of(high);
    expect(hi.crf!).toBeLessThan(lo.crf!);
    expect(hi.bytes).toBeGreaterThan(lo.bytes);
    expect((await stat(join(high, "public/_bytecut", hi.path))).size).toBe(hi.bytes);
  }, 240_000);

  it("is a cache hit on the second run: nothing is encoded and the manifest is byte-identical", async () => {
    const root = await project({ ssimulacra2: 65 });
    expect((await cli(root, ["optimize", "-y"])).code).toBe(0);
    const path = join(root, "public/_bytecut/bytecut-manifest.json");
    const first = await readFile(path, "utf8");
    const second = await cli(root, ["optimize", "-y"]);
    expect(second.code).toBe(0);
    expect(await readFile(path, "utf8")).toBe(first);
  }, 240_000);

  it("fits a size cap: a real file no larger than the cap, still above the floor", async () => {
    const free = await project({ ssimulacra2: 70 });
    expect((await cli(free, ["optimize", "-y"])).code).toBe(0);
    const uncapped = await h264Of(free);

    // 60% of what the target alone costs: reachable only by spending quality or pixels.
    const cap = Math.round(uncapped.bytes * 0.6);
    const root = await project({ ssimulacra2: 70, floor: 30, maxSize: cap });
    const before = await hashAll(join(root, "public/media"), ["long.mp4"]);
    const r = await cli(root, ["optimize", "-y"]);
    expect(r.code, r.stderr).toBe(0);

    const out = await h264Of(root);
    expect(out.status).toBe("written");
    expect(out.bytes).toBeLessThanOrEqual(cap);
    expect((await stat(join(root, "public/_bytecut", out.path))).size).toBe(out.bytes);
    expect(out.score!).toBeGreaterThanOrEqual(30);
    expect(out.search).toMatchObject({ target: 70, floor: 30, maxBytes: cap });
    // Cheaper than the target's own CRF, by a higher CRF or by a narrower picture.
    expect(out.crf! > uncapped.crf! || out.width < uncapped.width).toBe(true);
    if (out.search?.plannedPath) {
      expect(out.path).toBe(`media/long-${out.width}.h264.mp4`);
      expect(out.width).toBeLessThan(320);
      expect(out.width).toBeGreaterThanOrEqual(160);
    }
    expect(await hashAll(join(root, "public/media"), ["long.mp4"])).toEqual(before);

    // The second run recognises the (possibly narrower) output as the one the plan asks for.
    const path = join(root, "public/_bytecut/bytecut-manifest.json");
    const first = await readFile(path, "utf8");
    expect((await cli(root, ["optimize", "-y"])).code).toBe(0);
    expect(await readFile(path, "utf8")).toBe(first);
  }, 300_000);

  it("exits 1 and writes no video when the target is out of reach", async () => {
    const root = await project({ ssimulacra2: 100 });
    const r = await cli(root, ["optimize", "-y"]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/below the target 100/);
    const files = await listFiles(join(root, "public/_bytecut"));
    expect(files.filter((f) => f.endsWith(".mp4"))).toEqual([]);
  }, 180_000);
});

suite("video engine primitives with real ffmpeg", () => {
  const engine = () =>
    createFfmpegVideoEngine({
      env: process.env,
      platform: process.platform,
      deps: { isFile },
      run,
    });

  it("decodes the requested number of frames at exactly the requested size", async () => {
    const e = engine();
    const probe = (await e.probe(join(fixtures, "long.mp4")))!;
    const frames = await e.frames({
      source: join(fixtures, "long.mp4"),
      startSec: 2,
      durationSec: 2,
      count: 4,
      width: 160,
      height: 120,
      pipeline: { probe, maxWidth: null, maxFps: 12 },
    });
    expect(frames).toHaveLength(4);
    for (const f of frames) {
      expect([f.width, f.height, f.data.byteLength]).toEqual([160, 120, 160 * 120 * 3]);
    }
    // Real picture content, not an empty buffer: the test pattern has colour variety.
    expect(new Set(frames[0]!.data).size).toBeGreaterThan(10);
  });

  it("scores an encoded clip lower the higher the CRF, against the same reference", async () => {
    const e = engine();
    const probe = (await e.probe(join(fixtures, "long.mp4")))!;
    const scorer = await loadScorer();
    const source = join(fixtures, "long.mp4");
    const base = {
      source,
      encoder: "libx264" as const,
      speed: "veryfast",
      maxWidth: null,
      maxFps: null,
      startSec: 2,
      durationSec: 2,
      probe,
      count: 4,
      width: 320,
      height: 240,
    };
    const ref = await e.frames({
      ...base,
      pipeline: { probe, maxWidth: null, maxFps: null },
    });
    const meanAt = async (crf: number) => {
      const got = await e.encodedFrames({ ...base, crf });
      expect(got).toHaveLength(ref.length);
      const scores = await Promise.all(ref.map((r, i) => scorer.score(r, got[i]!)));
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    };
    const good = await meanAt(18);
    const bad = await meanAt(45);
    expect(good).toBeGreaterThan(bad + 10);
  });

  it("reports a missing libvmaf as an error rather than a score", async () => {
    const e = engine();
    const caps = await e.capabilities();
    if (caps?.libvmaf) return; // This ffmpeg has it: the degradation path does not apply.
    const probe = (await e.probe(join(fixtures, "long.mp4")))!;
    await expect(
      e.vmaf({
        source: join(fixtures, "long.mp4"),
        encoder: "libx264",
        crf: 30,
        speed: "veryfast",
        maxWidth: null,
        maxFps: null,
        startSec: 0,
        durationSec: 1,
        probe,
      }),
    ).rejects.toThrow(/libvmaf did not report a score/);
  });
});

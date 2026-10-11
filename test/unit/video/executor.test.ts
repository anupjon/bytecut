import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ImageEngine } from "../../../src/core/engines/types.js";
import { runPlan, type RunResult } from "../../../src/core/execute/run.js";
import { SafeFs } from "../../../src/core/fs-safe.js";
import { sha256 } from "../../../src/core/hash.js";
import { updateManifest } from "../../../src/core/manifest/update.js";
import type { Manifest } from "../../../src/core/manifest/types.js";
import { buildVideoItems } from "../../../src/core/plan/video.js";
import type { Plan, VideoPlanItem } from "../../../src/core/plan/types.js";
import { listFiles, tempDir } from "../../helpers.js";
import {
  ALL_ENCODERS,
  fakeVideoEngine,
  probeOf,
  type FakeVideoOptions,
} from "../../video-helpers.js";

const imageEngine: ImageEngine = {
  async analyze() {
    throw new Error("not used");
  },
  async encode(_input, request) {
    return {
      data: Buffer.alloc(300, 9),
      width: request.width,
      height: 100,
      encoder: "libaom-av1 3.15.1",
    };
  },
  encoders: () => ({ avif: "libaom-av1 3.15.1", webp: "libwebp 1.6.0" }),
  versions: () => ({}),
};

const SOURCE_BYTES = 50_000;

async function setup(
  options: FakeVideoOptions = {},
  files: Record<string, number> = { "media/clip.mp4": SOURCE_BYTES },
) {
  const root = await tempDir();
  for (const [path, size] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), Buffer.alloc(size, 3));
  }
  const outDir = join(root, "out");
  const fake = fakeVideoEngine(options);
  const videos = await buildVideoItems({
    files: Object.keys(files).map((f) => join(root, f)),
    projectRoot: root,
    staticRoot: ".",
    engine: fake.engine,
    needsFfmpeg: "install ffmpeg",
  });
  const fs = await SafeFs.create({
    projectRoot: root,
    outDir,
    sourceFiles: Object.keys(files).map((f) => join(root, f)),
    sourceDirs: [],
  });
  const plan: Plan = { version: 1, outDir: "out", publicPath: "/_bytecut", items: [], videos };
  return { root, outDir, fs, plan, videos, ...fake };
}

function run(
  ctx: Awaited<ReturnType<typeof setup>>,
  extra: Partial<Parameters<typeof runPlan>[1]> = {},
  engine: typeof ctx.engine | null = ctx.engine,
) {
  return runPlan(ctx.plan, {
    projectRoot: ctx.root,
    engine: imageEngine,
    fs: ctx.fs,
    manifest: null,
    ...(engine ? { video: { engine } } : {}),
    ...extra,
  });
}

function manifestAfter(
  ctx: Awaited<ReturnType<typeof setup>>,
  result: RunResult,
  previous: Manifest | null = null,
) {
  return updateManifest(previous, ctx.plan, result, {});
}

describe("video execution", () => {
  it("encodes both codecs and a poster through reserved temp files", async () => {
    const ctx = await setup({ bytes: (r) => (r.encoder === "libsvtav1" ? 8_000 : 12_000) });
    const result = await run(ctx);
    const v = result.videos![0]!;
    expect(v.status).toBe("done");
    expect(v.outputs.map((o) => [o.role, o.codec, o.status])).toEqual([
      ["video", "av1", "written"],
      ["video", "h264", "written"],
      ["poster", undefined, "written"],
    ]);
    const files = await listFiles(ctx.outDir);
    expect(files).toEqual([
      "media/clip-1280.av1.mp4",
      "media/clip-1280.h264.mp4",
      "media/clip-poster.avif",
    ]);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect((await stat(join(ctx.outDir, files[0]!))).size).toBe(8_000);
  });

  it("passes the resolved parameters to the encoder and never writes next to the source", async () => {
    const ctx = await setup();
    await run(ctx);
    const [av1, h264] = ctx.calls.encodes;
    expect(av1).toMatchObject({ encoder: "libsvtav1", crf: 32, speed: "6", audio: "keep" });
    expect(h264).toMatchObject({ encoder: "libx264", crf: 23, speed: "slow" });
    for (const req of ctx.calls.encodes) {
      expect(req.source).toBe(join(ctx.root, "media/clip.mp4"));
      expect(req.output.startsWith(ctx.outDir)).toBe(true);
      expect(req.output.endsWith(".tmp")).toBe(true);
    }
    expect(await listFiles(join(ctx.root, "media"))).toEqual(["clip.mp4"]);
  });

  it("extracts the poster from a frame near the start", async () => {
    const ctx = await setup({ defaultProbe: probeOf({ durationSec: 10 }) });
    await run(ctx);
    expect(ctx.calls.frames).toEqual([{ source: join(ctx.root, "media/clip.mp4"), at: 1 }]);
  });

  it("reports progress for each output", async () => {
    const ctx = await setup();
    const seen: Array<[string, number]> = [];
    await run(ctx, { onVideoProgress: (_s, path, f) => seen.push([path, f]) });
    expect(seen.some(([p, f]) => p.endsWith(".av1.mp4") && f === 1)).toBe(true);
    expect(seen.every(([, f]) => f >= 0 && f <= 1)).toBe(true);
  });

  it("does not write an output that is not smaller than the source (§6.7)", async () => {
    const ctx = await setup({
      bytes: (r) => (r.encoder === "libsvtav1" ? SOURCE_BYTES + 1 : 9_000),
    });
    const result = await run(ctx);
    expect(result.videos![0]!.outputs.map((o) => o.status)).toEqual([
      "already-optimal",
      "written",
      "written",
    ]);
    expect(await listFiles(ctx.outDir)).not.toContain("media/clip-1280.av1.mp4");
    expect((await listFiles(ctx.outDir)).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("is idempotent: a second run is entirely cached and encodes nothing", async () => {
    const ctx = await setup();
    const first = await run(ctx);
    const manifest = manifestAfter(ctx, first);
    const before = ctx.calls.encodes.length;
    const second = await run(ctx, { manifest });
    expect(second.videos![0]!.status).toBe("cached");
    expect(ctx.calls.encodes.length).toBe(before);
    expect(second.videos![0]!.outputs.every((o) => o.status === "unchanged")).toBe(true);
  });

  it("re-encodes only the outputs whose parameters changed", async () => {
    const ctx = await setup();
    const first = await run(ctx);
    const manifest = manifestAfter(ctx, first);
    // Same source, but AV1 quality changed in the plan.
    const changed: VideoPlanItem = {
      ...ctx.videos[0]!,
      outputs: ctx.videos[0]!.outputs.map((o) =>
        o.role === "video" && o.codec === "av1" ? { ...o, crf: 30 } : o,
      ),
    };
    ctx.plan.videos = [changed];
    const before = ctx.calls.encodes.length;
    const second = await run(ctx, { manifest });
    expect(ctx.calls.encodes.length - before).toBe(1);
    expect(ctx.calls.encodes.at(-1)).toMatchObject({ encoder: "libsvtav1", crf: 30 });
    expect(second.videos![0]!.outputs.map((o) => o.status)).toEqual([
      "written",
      "unchanged",
      "unchanged",
    ]);
  });

  it("force re-encodes everything", async () => {
    const ctx = await setup();
    const manifest = manifestAfter(ctx, await run(ctx));
    const before = ctx.calls.encodes.length;
    await run(ctx, { manifest, force: true });
    expect(ctx.calls.encodes.length - before).toBe(2);
  });

  it("fails a file whose source changed after the plan was made, writing nothing for it", async () => {
    const ctx = await setup();
    await writeFile(join(ctx.root, "media/clip.mp4"), Buffer.alloc(SOURCE_BYTES, 4));
    const result = await run(ctx);
    expect(result.videos![0]).toMatchObject({ status: "failed" });
    expect(result.videos![0]!.reason).toMatch(/source changed since the plan/);
    expect(ctx.calls.encodes).toEqual([]);
    expect(await listFiles(ctx.outDir)).toEqual([]);
  });

  it("runs videos with concurrency 1 by default", async () => {
    const files = { "a.mp4": SOURCE_BYTES, "b.mp4": SOURCE_BYTES, "c.mp4": SOURCE_BYTES };
    const ctx = await setup({ delayMs: 20 }, files);
    let active = 0;
    let peak = 0;
    const inner = ctx.engine.encode.bind(ctx.engine);
    ctx.engine.encode = async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await inner(...args);
      } finally {
        active--;
      }
    };
    await run(ctx);
    expect(peak).toBe(1);
    expect(ctx.calls.encodes).toHaveLength(6);
  });
});

describe("guardrail 6 for videos", () => {
  it("leaves an existing file it does not own alone, and warns", async () => {
    const ctx = await setup();
    const target = join(ctx.outDir, "media/clip-1280.h264.mp4");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "someone else's file");

    const result = await run(ctx);
    const h264 = result.videos![0]!.outputs.find((o) => o.codec === "h264")!;
    expect(h264.status).toBe("protected");
    expect(await readFile(target, "utf8")).toBe("someone else's file");
    expect(result.warnings.join("\n")).toMatch(/clip-1280\.h264\.mp4.*use --force/);
    expect((await listFiles(ctx.outDir)).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("accepts a file that is already byte-identical, without a write", async () => {
    const ctx = await setup({ bytes: () => 7_000 });
    const identical = Buffer.alloc(7_000, (23 + "libx264".length) % 251);
    const target = join(ctx.outDir, "media/clip-1280.h264.mp4");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, identical);
    const result = await run(ctx);
    expect(result.videos![0]!.outputs.find((o) => o.codec === "h264")!.status).toBe("unchanged");
    expect(result.warnings).toEqual([]);
  });

  it("overwrites it with force", async () => {
    const ctx = await setup({ bytes: () => 7_000 });
    const target = join(ctx.outDir, "media/clip-1280.h264.mp4");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "someone else's file");
    const result = await run(ctx, { force: true });
    expect(result.warnings).toEqual([]);
    expect((await stat(target)).size).toBe(7_000);
  });

  it("replaces a file the manifest owns and that is unmodified", async () => {
    const ctx = await setup({ bytes: () => 7_000 });
    const first = await run(ctx);
    const manifest = manifestAfter(ctx, first);
    // Make the plan differ so the output is regenerated, leaving the owned file in place.
    ctx.plan.videos = [
      {
        ...ctx.videos[0]!,
        outputs: ctx.videos[0]!.outputs.map((o) =>
          o.role === "video" ? { ...o, crf: o.crf + 1 } : o,
        ),
      },
    ];
    const second = await run(ctx, { manifest });
    expect(second.warnings).toEqual([]);
    expect(second.videos![0]!.outputs.filter((o) => o.status === "written")).toHaveLength(2);
  });
});

describe("degradation (§4)", () => {
  it("no ffmpeg: videos are reported as needing it, nothing is written, images are unaffected", async () => {
    const ctx = await setup({ caps: null });
    // With no capabilities the planner already listed it as skipped.
    expect(ctx.videos[0]!.skip?.reason).toMatch(/^needs ffmpeg/);
    const result = await run(ctx, {}, null);
    expect(result.videos![0]).toMatchObject({ status: "skipped" });
    expect(result.videos![0]!.reason).toMatch(/needs ffmpeg/);
    expect(await listFiles(ctx.outDir)).toEqual([]);
  });

  it("no ffmpeg at run time (plan saved elsewhere): still reported, not silently skipped", async () => {
    const ctx = await setup(); // planned with a working engine
    const dead = fakeVideoEngine({ caps: null }).engine;
    const result = await run(ctx, {}, dead);
    expect(result.videos![0]).toMatchObject({ status: "skipped", reason: "needs ffmpeg" });
    expect(await listFiles(ctx.outDir)).toEqual([]);
  });

  it("no AV1 encoder: H.264 and the poster are still produced, with a warning", async () => {
    const ctx = await setup({ caps: { ...ALL_ENCODERS, libsvtav1: false, libaomAv1: false } });
    const result = await run(ctx);
    expect(result.videos![0]!.outputs.map((o) => [o.codec ?? o.role, o.status])).toEqual([
      ["av1", "unavailable"],
      ["h264", "written"],
      ["poster", "written"],
    ]);
    expect(result.warnings.join("\n")).toMatch(
      /AV1 encoder not available \(needs libsvtav1 or libaom-av1\)/,
    );
    expect(ctx.calls.encodes.map((e) => e.encoder)).toEqual(["libx264"]);
    expect(await listFiles(ctx.outDir)).toEqual([
      "media/clip-1280.h264.mp4",
      "media/clip-poster.avif",
    ]);
  });

  it("falls back to libaom-av1 when only it is installed", async () => {
    const ctx = await setup({ caps: { ...ALL_ENCODERS, libsvtav1: false, libaomAv1: true } });
    await run(ctx);
    expect(ctx.calls.encodes[0]!.encoder).toBe("libaom-av1");
  });

  it("an unavailable AV1 output does not make the next run re-encode H.264", async () => {
    const ctx = await setup({ caps: { ...ALL_ENCODERS, libsvtav1: false, libaomAv1: false } });
    const first = await run(ctx);
    const manifest = manifestAfter(ctx, first);
    const before = ctx.calls.encodes.length;
    const second = await run(ctx, { manifest });
    expect(second.videos![0]!.status).toBe("cached");
    expect(ctx.calls.encodes.length).toBe(before);
  });

  it("no libx264: AV1 and the poster are produced, H.264 is reported", async () => {
    const ctx = await setup({ caps: { ...ALL_ENCODERS, libx264: false } });
    const result = await run(ctx);
    expect(result.videos![0]!.outputs.map((o) => o.status)).toEqual([
      "written",
      "unavailable",
      "written",
    ]);
    expect(result.warnings.join("\n")).toMatch(/H\.264 encoder not available/);
  });

  it("no libvmaf changes nothing about the output: quality is fixed per preset", async () => {
    const withVmaf = await setup({ caps: { ...ALL_ENCODERS, libvmaf: true } });
    const without = await setup({ caps: { ...ALL_ENCODERS, libvmaf: false } });
    await run(withVmaf);
    await run(without);
    expect(withVmaf.calls.encodes.map((e) => [e.encoder, e.crf, e.speed])).toEqual(
      without.calls.encodes.map((e) => [e.encoder, e.crf, e.speed]),
    );
  });
});

describe("cancel (§6.4)", () => {
  it("aborting mid-encode discards the temp file and leaves no output", async () => {
    const ctx = await setup({ delayMs: 5_000 });
    const controller = new AbortController();
    const running = run(ctx, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 60));
    controller.abort();
    const result = await running;

    expect(result.cancelled).toBe(true);
    expect(ctx.calls.aborted).toBeGreaterThan(0);
    expect(result.videos![0]!.status).toBe("cancelled");
    expect(result.videos![0]!.outputs.every((o) => o.status === "cancelled")).toBe(true);
    expect(await listFiles(ctx.outDir)).toEqual([]);
  });

  it("an output finished before the cancel is kept and recorded; the rest is not", async () => {
    let encodes = 0;
    const ctx = await setup({ bytes: () => 6_000 });
    const controller = new AbortController();
    const inner = ctx.engine.encode.bind(ctx.engine);
    ctx.engine.encode = async (...args) => {
      await inner(...args);
      if (++encodes === 1) controller.abort(); // after the AV1 file is fully written
    };
    const result = await run(ctx, { signal: controller.signal });
    expect(result.videos![0]!.outputs.map((o) => o.status)).toEqual([
      "written",
      "cancelled",
      "cancelled",
    ]);
    expect(await listFiles(ctx.outDir)).toEqual(["media/clip-1280.av1.mp4"]);

    // The manifest lists exactly the file on disk, so a resumed run reuses it.
    const manifest = manifestAfter(ctx, result);
    expect(Object.values(manifest.videos)[0]!.outputs.map((o) => o.path)).toEqual([
      "media/clip-1280.av1.mp4",
    ]);
    const onDisk = await readFile(join(ctx.outDir, "media/clip-1280.av1.mp4"));
    expect(Object.values(manifest.videos)[0]!.outputs[0]!.sha256).toBe(sha256(onDisk));

    ctx.engine.encode = inner;
    const before = ctx.calls.encodes.length;
    const resumed = await run(ctx, { manifest });
    expect(ctx.calls.encodes.length - before).toBe(1); // only H.264; AV1 was reused
    expect(resumed.videos![0]!.outputs.map((o) => o.status)).toEqual([
      "unchanged",
      "written",
      "written",
    ]);
  });

  it("an encode that fails is isolated and leaves no temp file", async () => {
    const ctx = await setup();
    const inner = ctx.engine.encode.bind(ctx.engine);
    let n = 0;
    ctx.engine.encode = async (req, p, s) => {
      if (n++ === 0) {
        await writeFile(req.output, "partial");
        throw new Error("ffmpeg exited with code 1");
      }
      return inner(req, p, s);
    };
    const result = await run(ctx);
    expect(result.videos![0]!.status).toBe("failed");
    expect(result.videos![0]!.outputs[0]).toMatchObject({
      status: "failed",
      error: "ffmpeg exited with code 1",
    });
    expect(result.videos![0]!.outputs[1]!.status).toBe("written");
    expect((await listFiles(ctx.outDir)).some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

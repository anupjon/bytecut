import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ImageEngine } from "../../../src/core/engines/types.js";
import { runPlan, type RunResult } from "../../../src/core/execute/run.js";
import { SafeFs } from "../../../src/core/fs-safe.js";
import { updateManifest } from "../../../src/core/manifest/update.js";
import { buildVideoItems } from "../../../src/core/plan/video.js";
import type { Plan } from "../../../src/core/plan/types.js";
import type { QualityScorer } from "../../../src/core/quality/types.js";
import { FRAMES_PER_CLIP } from "../../../src/core/quality/video-search.js";
import { listFiles, tempDir } from "../../helpers.js";
import {
  fakeVideoEngine,
  greyFrames,
  probeOf,
  type FakeVideoOptions,
} from "../../video-helpers.js";

const imageEngine: ImageEngine = {
  async analyze() {
    throw new Error("not used");
  },
  async encode(_input, request) {
    return { data: Buffer.alloc(300, 9), width: request.width, height: 100, encoder: "fake" };
  },
  encoders: () => ({ avif: "fake", webp: "fake" }),
  versions: () => ({}),
};

/** The score is the first byte of the encoded frame, so the fake engine decides it per CRF. */
const scorer: QualityScorer = {
  kind: "wasm",
  label: "fake",
  async score(_ref, got) {
    return got.data[0]!;
  },
  async close() {},
};

const SOURCE_BYTES = 50_000;
const DURATION = 60;
const SOURCE_WIDTH = 1280;

/** Bytes per second of an encode: falls with CRF, grows with the output's width. */
const perSecond = (crf: number, maxWidth: number | null) =>
  ((100 - crf) * Math.min(SOURCE_WIDTH, maxWidth ?? SOURCE_WIDTH)) / 1000;

/**
 * Score is 110 - crf (target 70 lands on crf 40) and size is perSecond(crf, width) * seconds:
 * AV1 can reach 3000 bytes at crf 61 (score 49); H.264 stops at crf 51 and must narrow.
 */
const model = (sampleScale = 1): FakeVideoOptions => ({
  encodedFrames: (r) => greyFrames(FRAMES_PER_CLIP, r.width, r.height, 110 - r.crf),
  sampleBytes: (r) => Math.round(perSecond(r.crf, r.maxWidth) * r.durationSec * sampleScale),
  bytes: (r) => Math.round(perSecond(r.crf, r.maxWidth) * DURATION),
});

async function setup(
  options: FakeVideoOptions,
  search: { metric: "ssimulacra2" | "vmaf"; target: number; floor?: number; maxBytes?: number },
) {
  const root = await tempDir();
  await mkdir(dirname(join(root, "media/clip.mp4")), { recursive: true });
  await writeFile(join(root, "media/clip.mp4"), Buffer.alloc(SOURCE_BYTES, 3));
  const fake = fakeVideoEngine({
    defaultProbe: probeOf({ durationSec: DURATION, width: SOURCE_WIDTH, hasAudio: false }),
    ...options,
  });
  const built = await buildVideoItems({
    files: [join(root, "media/clip.mp4")],
    projectRoot: root,
    staticRoot: ".",
    engine: fake.engine,
    needsFfmpeg: "install ffmpeg",
  });
  const videos = built.map((item) => ({
    ...item,
    outputs: item.outputs.map((o) => (o.role === "video" ? { ...o, search: { ...search } } : o)),
  }));
  const fs = await SafeFs.create({
    projectRoot: root,
    outDir: join(root, "out"),
    sourceFiles: [join(root, "media/clip.mp4")],
    sourceDirs: [],
  });
  const plan: Plan = { version: 1, outDir: "out", publicPath: "/_bytecut", items: [], videos };
  return { root, outDir: join(root, "out"), fs, plan, ...fake };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

const run = (ctx: Ctx, extra: Partial<Parameters<typeof runPlan>[1]> = {}) =>
  runPlan(ctx.plan, {
    projectRoot: ctx.root,
    engine: imageEngine,
    fs: ctx.fs,
    manifest: null,
    video: { engine: ctx.engine },
    quality: { scorer: async () => scorer },
    ...extra,
  });

const manifestAfter = (ctx: Ctx, result: RunResult) => updateManifest(null, ctx.plan, result, {});

const videosOf = (result: RunResult) =>
  result.videos![0]!.outputs.filter((o) => o.role === "video");

describe("a size cap on a searched video", () => {
  it("raises the CRF to fit, narrows only a codec that cannot, and keeps both under the cap", async () => {
    const ctx = await setup(model(), {
      metric: "ssimulacra2",
      target: 70,
      floor: 45,
      maxBytes: 3000,
    });
    const result = await run(ctx);
    const [av1, h264] = videosOf(result);

    // AV1 fits at full width by going from crf 40 to 61, which still scores above the floor.
    expect(av1).toMatchObject({ codec: "av1", status: "written", width: 1280, crf: 61 });
    expect(av1!.path).toBe("media/clip-1280.av1.mp4");
    expect(av1!.score).toBeGreaterThanOrEqual(45);
    expect(av1!.search?.plannedPath).toBeUndefined();

    // H.264 tops out at crf 51 (3763 bytes at 1280), so the width steps down until it fits.
    expect(h264).toMatchObject({ codec: "h264", status: "written", width: 818 });
    expect(h264!.path).toBe("media/clip-818.h264.mp4");
    expect(h264!.search?.plannedPath).toBe("media/clip-1280.h264.mp4");

    for (const out of [av1!, h264!]) expect(out.bytes).toBeLessThanOrEqual(3000);
    expect(await listFiles(ctx.outDir)).toEqual(
      ["media/clip-1280.av1.mp4", "media/clip-818.h264.mp4", "media/clip-poster.avif"].sort(),
    );
    // The encoder was really given the narrower width.
    expect(ctx.calls.encodes.filter((e) => e.encoder === "libx264").at(-1)!.maxWidth).toBe(818);
  });

  it("leaves a video alone that already fits: the quality CRF is used as it is", async () => {
    const ctx = await setup(model(), {
      metric: "ssimulacra2",
      target: 70,
      floor: 45,
      maxBytes: 50_000,
    });
    const result = await run(ctx);
    expect(videosOf(result).map((o) => [o.codec, o.crf, o.width])).toEqual([
      ["av1", 40, 1280],
      ["h264", 40, 1280],
    ]);
  });

  it("records the planned path, is a cache hit afterwards, and a miss when the cap changes", async () => {
    const ctx = await setup(model(), {
      metric: "ssimulacra2",
      target: 70,
      floor: 45,
      maxBytes: 3000,
    });
    const manifest = manifestAfter(ctx, await run(ctx));
    const recorded = manifest.videos["media/clip.mp4"]!.outputs.find((o) => o.codec === "h264")!;
    expect(recorded).toMatchObject({
      path: "media/clip-818.h264.mp4",
      width: 818,
      search: { maxBytes: 3000, floor: 45, plannedPath: "media/clip-1280.h264.mp4" },
    });

    const encodes = ctx.calls.encodes.length;
    const again = await run(ctx, { manifest });
    expect(again.videos![0]!.status).toBe("cached");
    expect(ctx.calls.encodes.length).toBe(encodes);

    for (const out of ctx.plan.videos![0]!.outputs) {
      if (out.role === "video") out.search = { ...out.search!, maxBytes: 3500 };
    }
    const looser = await run(ctx, { manifest });
    expect(looser.videos![0]!.status).toBe("done");
    expect(ctx.calls.encodes.length).toBeGreaterThan(encodes);
  });

  it("fails the item and writes no video when even half the width cannot hold the cap", async () => {
    const ctx = await setup(model(), {
      metric: "ssimulacra2",
      target: 70,
      floor: 45,
      maxBytes: 1000,
    });
    const result = await run(ctx);
    expect(result.videos![0]!.status).toBe("failed");
    expect(videosOf(result).map((o) => o.status)).toEqual(["unmet", "unmet"]);
    expect(result.warnings.join("\n")).toMatch(/size cap could not be met at \d+px/);
    expect(await listFiles(ctx.outDir)).toEqual(["media/clip-poster.avif"]);
  });

  it("does not trade quality below the floor for size", async () => {
    // Floor 60 forbids crf 61 (score 49): AV1 has to narrow instead of degrading.
    const ctx = await setup(model(), {
      metric: "ssimulacra2",
      target: 70,
      floor: 60,
      maxBytes: 3000,
    });
    const result = await run(ctx);
    const av1 = videosOf(result).find((o) => o.codec === "av1")!;
    expect(av1.width).toBeLessThan(1280);
    expect(av1.score).toBeGreaterThanOrEqual(60);
    expect(av1.bytes).toBeLessThanOrEqual(3000);
  });

  it("checks the real file: a prediction that was too low bumps the CRF, then narrows", async () => {
    // Samples claim half the real size, so the first CRF chosen is too big once encoded.
    const ctx = await setup(model(0.5), {
      metric: "ssimulacra2",
      target: 70,
      floor: 45,
      maxBytes: 3000,
    });
    const result = await run(ctx);
    for (const out of videosOf(result)) {
      expect(out.status).toBe("written");
      expect(out.bytes).toBeLessThanOrEqual(3000);
    }
    // The AV1 encodes went up in CRF steps of 2 and a bounded number of times.
    const av1Crfs = ctx.calls.encodes.filter((e) => e.encoder === "libsvtav1").map((e) => e.crf);
    expect(av1Crfs.length).toBeLessThanOrEqual(12);
    expect(av1Crfs.slice(0, 2)).toEqual([...av1Crfs.slice(0, 1), av1Crfs[0]! + 2]);
  });

  it("holds a CRF raised only to fit to the floor, not to the target, on the real file", async () => {
    // The full-length output scores 55: under the target (70), over the floor (45).
    const ctx = await setup(
      {
        ...model(),
        frames: (r) =>
          greyFrames(FRAMES_PER_CLIP, r.width, r.height, r.pipeline === null ? 55 : 128),
      },
      { metric: "ssimulacra2", target: 70, floor: 45, maxBytes: 3000 },
    );
    const av1 = videosOf(await run(ctx)).find((o) => o.codec === "av1")!;
    expect(av1).toMatchObject({ status: "written", crf: 61, width: 1280, score: 55 });
  });

  it("without a size cap nothing narrows and the planned path is used", async () => {
    const ctx = await setup(model(), { metric: "ssimulacra2", target: 70 });
    const result = await run(ctx);
    expect(videosOf(result).map((o) => o.path)).toEqual([
      "media/clip-1280.av1.mp4",
      "media/clip-1280.h264.mp4",
    ]);
  });
});

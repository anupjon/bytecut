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
  ALL_ENCODERS,
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

/** The score is the first byte of the encoded frame, so a fake engine decides it per CRF. */
const scorer: QualityScorer = {
  kind: "wasm",
  label: "fake",
  async score(_ref, got) {
    return got.data[0]!;
  },
  async close() {},
};

const SOURCE_BYTES = 50_000;
type Metric = "ssimulacra2" | "vmaf";

async function setup(
  options: FakeVideoOptions = {},
  search: { metric: Metric; target: number } | null = { metric: "ssimulacra2", target: 70 },
  duration = 60,
) {
  const root = await tempDir();
  const files = { "media/clip.mp4": SOURCE_BYTES };
  for (const [path, size] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), Buffer.alloc(size, 3));
  }
  const fake = fakeVideoEngine({
    defaultProbe: probeOf({ durationSec: duration }),
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
    outputs: item.outputs.map((o) =>
      o.role === "video" && search ? { ...o, search: { ...search } } : o,
    ),
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

const manifestAfter = (ctx: Ctx, result: RunResult, previous = null as never) =>
  updateManifest(previous, ctx.plan, result, {});

/** Score 110 - crf on every clip. AV1 target 70 therefore lands on crf 40. */
const linear: FakeVideoOptions = {
  encodedFrames: (r) => greyFrames(FRAMES_PER_CLIP, r.width, r.height, 110 - r.crf),
};

describe("video execution with a perceptual search", () => {
  it("encodes at the CRF the search found and records how", async () => {
    const ctx = await setup(linear);
    const result = await run(ctx);
    const outputs = result.videos![0]!.outputs.filter((o) => o.role === "video");
    expect(outputs.map((o) => [o.codec, o.crf, o.status])).toEqual([
      ["av1", 40, "written"],
      ["h264", 40, "written"],
    ]);
    // Neither codec's fixed CRF (32 / 23) was used for the real output.
    expect(ctx.calls.encodes.map((e) => e.crf)).toEqual([40, 40]);
    expect(outputs[0]).toMatchObject({
      search: { metric: "ssimulacra2", target: 70 },
      scorer: "wasm",
    });
    expect(outputs[0]!.score).toBeGreaterThanOrEqual(70);

    const manifest = manifestAfter(ctx, result);
    const recorded = manifest.videos["media/clip.mp4"]!.outputs.find((o) => o.codec === "av1")!;
    expect(recorded).toMatchObject({
      crf: 40,
      search: { metric: "ssimulacra2", target: 70 },
      scorer: "wasm",
    });
    expect(recorded.score).toBeGreaterThanOrEqual(70);
  });

  it("is a cache hit the second time, and a miss only when the target changes", async () => {
    const ctx = await setup(linear);
    const manifest = manifestAfter(ctx, await run(ctx));
    const encodes = ctx.calls.encodes.length;
    const probes = ctx.calls.encodedFrames.length;

    const again = await run(ctx, { manifest });
    expect(again.videos![0]!.status).toBe("cached");
    expect(ctx.calls.encodes.length).toBe(encodes);
    expect(ctx.calls.encodedFrames.length).toBe(probes);

    for (const output of ctx.plan.videos![0]!.outputs) {
      if (output.role === "video") output.search = { metric: "ssimulacra2", target: 85 };
    }
    const stricter = await run(ctx, { manifest });
    expect(stricter.videos![0]!.status).toBe("done");
    expect(ctx.calls.encodes.slice(encodes).map((e) => e.crf)).toEqual([25, 25]);
  });

  it("re-encodes at a lower CRF when the full output scores below the sampled clips", async () => {
    // The sampled clips say crf 40 is fine; the real output at 40 and 38 is not.
    const ctx = await setup({
      ...linear,
      frames: (r) =>
        greyFrames(FRAMES_PER_CLIP, r.width, r.height, r.pipeline === null ? bumpLevel(ctx) : 0),
    });
    // The level of the confirmation frames follows the CRF of the latest encode.
    function bumpLevel(c: Ctx): number {
      const crf = c.calls.encodes.at(-1)!.crf;
      return crf > 38 ? 60 : 75;
    }
    const result = await run(ctx);
    const av1 = result.videos![0]!.outputs.find((o) => o.codec === "av1")!;
    expect(av1).toMatchObject({ status: "written", crf: 38 });
    expect(ctx.calls.encodes.filter((e) => e.encoder === "libsvtav1").map((e) => e.crf)).toEqual([
      40, 38,
    ]);
    expect(av1.score).toBe(75);
  });

  it("writes nothing and fails the item when the full output never reaches the target", async () => {
    const ctx = await setup({
      ...linear,
      frames: (r) => greyFrames(FRAMES_PER_CLIP, r.width, r.height, r.pipeline === null ? 10 : 0),
    });
    const result = await run(ctx);
    const v = result.videos![0]!;
    expect(v.status).toBe("failed");
    expect(v.outputs.filter((o) => o.role === "video").map((o) => o.status)).toEqual([
      "unmet",
      "unmet",
    ]);
    // Poster is independent of the constraint and still made; no video file exists.
    expect(await listFiles(ctx.outDir)).toEqual(["media/clip-poster.avif"]);
    expect(result.warnings.join("\n")).toMatch(/below the target 70/);
    // A bounded number of retries per codec, not an unbounded loop.
    expect(ctx.calls.encodes.filter((e) => e.encoder === "libsvtav1").length).toBeLessThanOrEqual(
      4,
    );
  });

  it("fails an output whose target cannot be reached even at the best CRF, without encoding it", async () => {
    const ctx = await setup({
      encodedFrames: (r) => greyFrames(FRAMES_PER_CLIP, r.width, r.height, 50),
    });
    const result = await run(ctx);
    const v = result.videos![0]!;
    expect(v.status).toBe("failed");
    expect(v.outputs.filter((o) => o.role === "video").every((o) => o.status === "unmet")).toBe(
      true,
    );
    expect(ctx.calls.encodes).toEqual([]);
    expect(v.outputs[0]!.error).toMatch(
      /ssimulacra2 reached only 50\.0 at crf 10, below the target 70/,
    );
    expect(await listFiles(ctx.outDir)).toEqual(["media/clip-poster.avif"]);
  });

  it("scores a short video whole and does not repeat the encode to confirm it", async () => {
    const ctx = await setup(linear, undefined, 4);
    const result = await run(ctx);
    expect(result.videos![0]!.status).toBe("done");
    // One clip (the whole video), and no confirmation decode of an output.
    expect(ctx.calls.clipFrames.every((f) => f.pipeline !== null)).toBe(true);
    expect(ctx.calls.clipFrames.length).toBe(2); // one reference per codec
  });

  it("uses the fixed CRF, says why, and still caches when there is no scorer", async () => {
    const ctx = await setup(linear);
    const first = await run(ctx, { quality: undefined });
    expect(ctx.calls.encodes.map((e) => e.crf)).toEqual([32, 23]);
    expect(first.warnings.join("\n")).toMatch(/no quality scorer is available/);
    const manifest = manifestAfter(ctx, first);
    const recorded = manifest.videos["media/clip.mp4"]!.outputs.find((o) => o.codec === "av1")!;
    expect(recorded.search).toEqual({ metric: "ssimulacra2", target: 70 });
    expect(recorded.score).toBeUndefined();

    const again = await run(ctx, { manifest, quality: undefined });
    expect(again.videos![0]!.status).toBe("cached");
  });

  it("searches an output that was made without a score once a scorer is available", async () => {
    const ctx = await setup(linear);
    const manifest = manifestAfter(ctx, await run(ctx, { quality: undefined }));
    const before = ctx.calls.encodes.length;
    const second = await run(ctx, { manifest });
    expect(second.videos![0]!.status).toBe("done");
    expect(ctx.calls.encodes.slice(before).map((e) => e.crf)).toEqual([40, 40]);
  });

  describe("vmaf", () => {
    it("searches with libvmaf when ffmpeg has it", async () => {
      const ctx = await setup(
        {
          caps: { ...ALL_ENCODERS, libvmaf: true },
          vmaf: (r) => 100 - r.crf * 0.5,
        },
        { metric: "vmaf", target: 90 },
      );
      const result = await run(ctx, { quality: undefined });
      const av1 = result.videos![0]!.outputs.find((o) => o.codec === "av1")!;
      expect(av1).toMatchObject({
        status: "written",
        crf: 20,
        search: { metric: "vmaf", target: 90 },
        scorer: "libvmaf",
      });
      expect(ctx.calls.encodedFrames).toEqual([]);
    });

    it("falls back to the fixed CRF with a warning when libvmaf is missing", async () => {
      const ctx = await setup(
        { caps: { ...ALL_ENCODERS, libvmaf: false } },
        { metric: "vmaf", target: 90 },
      );
      const result = await run(ctx);
      expect(result.videos![0]!.status).toBe("done");
      expect(ctx.calls.encodes.map((e) => e.crf)).toEqual([32, 23]);
      expect(ctx.calls.vmaf).toEqual([]);
      expect(result.warnings.join("\n")).toMatch(/libvmaf is missing/);
      expect(result.warnings.join("\n")).toMatch(/fixed CRF 32/);
    });
  });
});

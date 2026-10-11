import { describe, expect, it } from "vitest";
import type { ImageAnalysis, ImageEngine } from "../../../src/core/engines/types.js";
import { buildPlan, targetWidths } from "../../../src/core/plan/build.js";
import { fakeAnalysis } from "../../helpers.js";
import { PHOTO_PRESET, type ImagePreset } from "../../../src/core/presets/photo.js";

describe("targetWidths", () => {
  const widths = [640, 1280, 1920];
  it("keeps preset widths up to the source width", () => {
    expect(targetWidths(widths, 4000)).toEqual([640, 1280, 1920]);
    expect(targetWidths(widths, 1920)).toEqual([640, 1280, 1920]);
  });
  it("adds the native width for sources between preset widths", () => {
    expect(targetWidths(widths, 1000)).toEqual([640, 1000]);
  });
  it("never upscales a small source", () => {
    expect(targetWidths(widths, 300)).toEqual([300]);
  });
});

/** Fake engine: the probe result is looked up by the buffer's text content. */
function fakeEngine(probes: Record<string, Partial<ImageAnalysis> | "throw">): ImageEngine {
  return {
    async analyze(input) {
      const probe = probes[input.toString()];
      if (probe === "throw" || probe === undefined) throw new Error("corrupt");
      return fakeAnalysis(probe);
    },
    async encode() {
      throw new Error("not used in planning");
    },
    encoders: () => ({ avif: "fake", webp: "fake" }),
    versions: () => ({}),
  };
}

function build(
  files: Record<string, Partial<ImageAnalysis> | "throw">,
  root = "/p",
  staticRoot = ".",
) {
  return buildPlan({
    files: Object.keys(files).map((f) => `${root}/${f}`),
    projectRoot: root,
    outDir: `${root}/public/_bytecut`,
    staticRoot,
    choosePreset: () => ({ preset: PHOTO_PRESET, reason: "test" }),
    engine: fakeEngine(files),
    readSource: async (path) => Buffer.from(Object.keys(files).find((f) => path.endsWith(f)) ?? ""),
  });
}

describe("buildPlan", () => {
  it("mirrors the source tree under <basename>/<basename>-<width>.<ext>", async () => {
    const plan = await build({ "img/hero.jpg": { width: 1400 } });
    expect(plan.outDir).toBe("public/_bytecut");
    expect(plan.items[0]?.outputs.map((o) => o.path)).toEqual([
      "img/hero/hero-640.avif",
      "img/hero/hero-640.webp",
      "img/hero/hero-1280.avif",
      "img/hero/hero-1280.webp",
      "img/hero/hero-1400.avif",
      "img/hero/hero-1400.webp",
    ]);
  });

  it("encodes PNG as lossless WebP but lossy AVIF (§6.8)", async () => {
    const plan = await build({ "a.png": { format: "png", width: 500 } });
    const [avif, webp] = plan.items[0]!.outputs;
    expect(avif).toMatchObject({ format: "avif", lossless: false, width: 500 });
    expect(webp).toMatchObject({ format: "webp", lossless: true, width: 500 });
  });

  it("encodes JPEG lossy in both formats", async () => {
    const plan = await build({ "a.jpg": { width: 500 } });
    expect(plan.items[0]!.outputs.every((o) => !o.lossless)).toBe(true);
  });

  it("uses oriented dimensions and records them", async () => {
    const plan = await build({ "a.jpg": { width: 500, height: 800 } });
    expect(plan.items[0]).toMatchObject({ sourceWidth: 500, sourceHeight: 800 });
  });

  it("lists animated, unsupported and corrupt files as skipped, sorted by path", async () => {
    const plan = await build({
      "anim.webp": { format: "webp", animated: true },
      "odd.jpg": { format: "other" },
      "bad.jpg": "throw",
    });
    expect(plan.items.map((i) => i.skip?.reason)).toEqual([
      "animated image", // anim.webp
      "unreadable or corrupt image", // bad.jpg
      "unsupported image format", // odd.jpg
    ]);
    expect(plan.items.every((i) => i.outputs.length === 0)).toBe(true);
  });

  it("refuses two sources that would write the same output", async () => {
    await expect(
      build({ "a/hero.jpg": {}, "a/hero.png": { format: "png" } }),
    ).rejects.toMatchObject({
      code: "OUTPUT_COLLISION",
    });
  });

  it("refuses sources outside the project root", async () => {
    await expect(
      buildPlan({
        files: ["/elsewhere/a.jpg"],
        projectRoot: "/p",
        outDir: "/p/out",
        choosePreset: () => ({ preset: PHOTO_PRESET, reason: "test" }),
        engine: fakeEngine({}),
        readSource: async () => Buffer.alloc(0),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_OUTSIDE_PROJECT" });
  });

  it("mirrors relative to the static root so URLs parallel how assets are served", async () => {
    const plan = await build(
      { "public/img/hero.jpg": { width: 700 }, "src/assets/a.jpg": { width: 700 } },
      "/p",
      "public",
    );
    const paths = plan.items.flatMap((i) => i.outputs.map((o) => o.path));
    expect(paths).toContain("img/hero/hero-640.avif");
    // Outside the static root: mirrored from the project root instead.
    expect(paths).toContain("src/assets/a/a-640.avif");
  });

  it("records the preset and why it was chosen", async () => {
    const plan = await build({ "a.jpg": { width: 700 } });
    expect(plan.items[0]).toMatchObject({
      preset: "photo",
      classification: { reason: "test" },
    });
  });

  it("applies a preset's lossless flag to every format", async () => {
    const plan = await buildPlan({
      files: ["/p/a.jpg"],
      projectRoot: "/p",
      outDir: "/p/out",
      choosePreset: () => ({
        preset: { ...PHOTO_PRESET, name: "flat", lossless: true },
        reason: "x",
      }),
      engine: fakeEngine({ "a.jpg": { width: 500 } }),
      readSource: async () => Buffer.from("a.jpg"),
    });
    expect(plan.items[0]!.outputs.every((o) => o.lossless)).toBe(true);
  });

  it("is JSON-serializable data", async () => {
    const plan = await build({ "a.jpg": { width: 700 } });
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });
});

describe("buildPlan: perceptual search", () => {
  const searching = { ...PHOTO_PRESET, search: { metric: "ssimulacra2" as const, target: 80 } };
  const planWith = (analysis: Partial<ImageAnalysis>, preset: ImagePreset = searching) =>
    buildPlan({
      files: ["/p/img/a"],
      projectRoot: "/p",
      outDir: "/p/out",
      choosePreset: () => ({ preset, reason: "test" }),
      engine: fakeEngine({ "": analysis }),
      readSource: async () => Buffer.from(""),
    });

  it("copies the preset's target onto every lossy output", async () => {
    const plan = await planWith({ width: 1400, format: "jpeg" });
    expect(plan.items[0]!.outputs.every((o) => o.search?.target === 80 && !o.lossless)).toBe(true);
  });

  it("does not search a lossless output: it is exact", async () => {
    const plan = await planWith({ width: 1400, format: "png" });
    const outputs = plan.items[0]!.outputs;
    const lossless = outputs.filter((o) => o.lossless);
    expect(lossless.length).toBeGreaterThan(0);
    expect(lossless.every((o) => o.search === undefined)).toBe(true);
    expect(outputs.filter((o) => !o.lossless).every((o) => o.search !== undefined)).toBe(true);
  });

  it("gives each output its own copy, so one cannot change another's", async () => {
    const plan = await planWith({ width: 1400, format: "jpeg" });
    const [a, b] = plan.items[0]!.outputs;
    expect(a!.search).not.toBe(b!.search);
    expect(a!.search).not.toBe(searching.search);
  });

  it("a preset without a target plans exactly as before", async () => {
    const plan = await planWith({ width: 1400, format: "jpeg" }, PHOTO_PRESET);
    expect(plan.items[0]!.outputs.every((o) => !("search" in o))).toBe(true);
  });
});

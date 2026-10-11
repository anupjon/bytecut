import { describe, expect, it } from "vitest";
import type { ImageAnalysis, ImageEngine } from "../../../src/core/engines/types.js";
import { buildPlan, outputWidths, targetWidths } from "../../../src/core/plan/build.js";
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

describe("outputWidths (longest side capped)", () => {
  const photo = { widths: [], maxEdge: 1920 };
  it("makes a landscape image maxEdge wide", () => {
    expect(outputWidths(photo, 4000, 3000)).toEqual([1920]);
  });
  it("makes a portrait image maxEdge tall, with the width in proportion", () => {
    // 3000 x 4000 → 1440 x 1920.
    expect(outputWidths(photo, 3000, 4000)).toEqual([1440]);
    expect(outputWidths(photo, 1080, 2400)).toEqual([864]);
  });
  it("handles a square image and an extreme panorama", () => {
    expect(outputWidths(photo, 3000, 3000)).toEqual([1920]);
    expect(outputWidths(photo, 8000, 1000)).toEqual([1920]);
  });
  it("rounds the width down, so the height never exceeds the cap", () => {
    // 1001 x 3001 → 1001*1920/3001 = 640.4 → 640; 3001*640/1001 = 1918.6 ≤ 1920.
    const [w] = outputWidths(photo, 1001, 3001);
    expect(w).toBe(640);
    expect(Math.round((3001 * w!) / 1001)).toBeLessThanOrEqual(1920);
  });
  it("never upscales: an image within the cap keeps its native size", () => {
    expect(outputWidths(photo, 1920, 1080)).toEqual([1920]);
    expect(outputWidths(photo, 800, 1920)).toEqual([800]);
    expect(outputWidths(photo, 640, 480)).toEqual([640]);
  });
  it("uses the width list when a preset has no maxEdge", () => {
    expect(outputWidths({ widths: [640, 1280] }, 4000, 3000)).toEqual([640, 1280]);
    expect(outputWidths({ widths: [640, 1280] }, 900, 3000)).toEqual([640, 900]);
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
    encoders: () => ({ jpg: "fake", png: "fake", avif: "fake", webp: "fake" }),
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
    // 1400 is within the 1920 cap: one JPEG, at its native width.
    expect(plan.items[0]?.outputs.map((o) => o.path)).toEqual(["img/hero/hero-1400.jpg"]);
  });

  it("caps a large landscape at 1920 wide and a large portrait at 1920 tall", async () => {
    const plan = await build({
      "wide.jpg": { width: 4000, height: 3000 },
      "tall.jpg": { width: 3000, height: 4000 },
    });
    const paths = (i: number) => plan.items[i]!.outputs.map((o) => o.path);
    expect(paths(0)).toEqual(["tall/tall-1440.jpg"]);
    expect(paths(1)).toEqual(["wide/wide-1920.jpg"]);
  });

  it("writes a single lossy JPEG by default", async () => {
    const plan = await build({ "a.jpg": { width: 500 } });
    expect(plan.items[0]!.outputs).toMatchObject([
      { format: "jpg", lossless: false, width: 500, path: "a/a-500.jpg" },
    ]);
  });

  it("turns a photographic PNG into a JPEG", async () => {
    const plan = await build({ "a.png": { format: "png", width: 500 } });
    expect(plan.items[0]!.outputs).toMatchObject([{ format: "jpg", lossless: false }]);
  });

  describe("formats that cannot be JPEG", () => {
    const planFor = (
      analysis: Partial<ImageAnalysis>,
      over: Partial<ImagePreset> = {},
      confidence?: "high" | "medium" | "low",
    ) =>
      buildPlan({
        files: ["/p/a"],
        projectRoot: "/p",
        outDir: "/p/out",
        choosePreset: () => ({
          preset: { ...PHOTO_PRESET, ...over },
          reason: "test",
          ...(confidence ? { confidence } : {}),
        }),
        engine: fakeEngine({ "": analysis }),
        readSource: async () => Buffer.from(""),
      });

    it("keeps transparency by writing a lossless PNG instead of a JPEG (§6.9)", async () => {
      const plan = await planFor({ format: "png", width: 500, hasAlpha: true, alphaUsed: true });
      expect(plan.items[0]!.outputs).toMatchObject([
        { format: "png", lossless: true, path: "a/a-500.png" },
      ]);
    });

    it("does not treat an unused alpha channel as transparency", async () => {
      const plan = await planFor({ format: "png", width: 500, hasAlpha: true, alphaUsed: false });
      expect(plan.items[0]!.outputs).toMatchObject([{ format: "jpg" }]);
    });

    it("keeps a PNG the classifier could not place lossless (§6.8)", async () => {
      const plan = await planFor({ format: "png", width: 500 }, {}, "low");
      expect(plan.items[0]!.outputs).toMatchObject([{ format: "png", lossless: true }]);
      // A confident verdict, or a file the user assigned to a preset, may become a JPEG.
      expect(
        (await planFor({ format: "png", width: 500 }, {}, "high")).items[0]!.outputs,
      ).toMatchObject([{ format: "jpg" }]);
    });

    it("never makes a JPEG lossless: a lossless preset gets PNG", async () => {
      const plan = await planFor({ width: 500 }, { lossless: true });
      expect(plan.items[0]!.outputs).toMatchObject([{ format: "png", lossless: true }]);
    });

    it("leaves webp and avif to carry transparency themselves", async () => {
      const plan = await planFor(
        { format: "png", width: 500, hasAlpha: true, alphaUsed: true },
        { formats: ["jpg", "webp", "avif"] },
      );
      expect(plan.items[0]!.outputs.map((o) => [o.format, o.lossless])).toEqual([
        ["png", true],
        ["webp", true],
        ["avif", false],
      ]);
    });

    it("does not list PNG twice when a JPEG was swapped for it", async () => {
      const plan = await planFor(
        { format: "png", width: 500, hasAlpha: true, alphaUsed: true },
        { formats: ["jpg", "png"] },
      );
      expect(plan.items[0]!.outputs.map((o) => o.path)).toEqual(["a/a-500.png"]);
    });

    it("lists each format once and in the preset's order", async () => {
      const plan = await planFor({ width: 500 }, { formats: ["avif", "jpg", "webp"] });
      expect(plan.items[0]!.outputs.map((o) => o.format)).toEqual(["avif", "jpg", "webp"]);
    });
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
    expect(paths).toContain("img/hero/hero-700.jpg");
    // Outside the static root: mirrored from the project root instead.
    expect(paths).toContain("src/assets/a/a-700.jpg");
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
  // Two lossy formats, so "every output" and "its own copy" are about more than one.
  const searching = {
    ...PHOTO_PRESET,
    formats: ["jpg", "webp"] as ImagePreset["formats"],
    search: { metric: "ssimulacra2" as const, target: 80 },
  };
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
    expect(plan.items[0]!.outputs).toHaveLength(2);
    expect(plan.items[0]!.outputs.every((o) => o.search?.target === 80 && !o.lossless)).toBe(true);
  });

  it("does not search a lossless output: it is exact", async () => {
    // A PNG source with webp in the preset: the webp is lossless (exact), the JPEG is lossy.
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

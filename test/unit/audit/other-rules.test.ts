import { describe, expect, it } from "vitest";
import { duplicate } from "../../../src/core/audit/rules/duplicate.js";
import { svgEmbeddedRaster } from "../../../src/core/audit/rules/embedded-raster.js";
import { gifAnimated } from "../../../src/core/audit/rules/gif-animated.js";
import { gifStatic } from "../../../src/core/audit/rules/gif-static.js";
import { overBudget, servedBytes } from "../../../src/core/audit/rules/over-budget.js";
import { svgUnminified } from "../../../src/core/audit/rules/unminified.js";
import { unreferenced } from "../../../src/core/audit/rules/unreferenced.js";
import type { Manifest } from "../../../src/core/manifest/types.js";
import { context, estimate, image, svg } from "../../audit-helpers.js";

describe("svg/unminified", () => {
  it("flags files svgo shrinks meaningfully", async () => {
    const f = await svgUnminified.check(
      context({ svgs: [svg({ bytes: 10_000, minifiedBytes: 4_000 })] }),
    );
    expect(f).toEqual([
      expect.objectContaining({
        ruleId: "svg/unminified",
        current: 10_000,
        estimated: 4_000,
        savingsBytes: 6_000,
      }),
    ]);
  });

  it("needs both the percentage and byte thresholds, and skips unparseable files", async () => {
    const lowPercent = svg({ bytes: 100_000, minifiedBytes: 95_000 });
    const lowBytes = svg({ bytes: 400, minifiedBytes: 300 });
    const broken = svg({ minifiedBytes: null });
    expect(await svgUnminified.check(context({ svgs: [lowPercent, lowBytes, broken] }))).toEqual(
      [],
    );
  });

  it("honours its options", async () => {
    const ctx = context({
      svgs: [svg({ bytes: 1_000, minifiedBytes: 850 })],
      opts: { "svg/unminified": { minPercent: 5, minBytes: 100 } },
    });
    expect(await svgUnminified.check(ctx)).toHaveLength(1);
  });
});

describe("svg/embedded-raster", () => {
  it("flags embedded base64 rasters above the threshold", async () => {
    const f = await svgEmbeddedRaster.check(
      context({ svgs: [svg({ embeddedRasterCount: 2, embeddedRasterBytes: 30_000 })] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/embeds 2 raster images/);
  });

  it("ignores none, tiny, and honours minBytes", async () => {
    expect(await svgEmbeddedRaster.check(context({ svgs: [svg()] }))).toEqual([]);
    const tiny = svg({ embeddedRasterCount: 1, embeddedRasterBytes: 200 });
    expect(await svgEmbeddedRaster.check(context({ svgs: [tiny] }))).toEqual([]);
    const ctx = context({ svgs: [tiny], opts: { "svg/embedded-raster": { minBytes: 100 } } });
    expect(await svgEmbeddedRaster.check(ctx)).toHaveLength(1);
  });
});

describe("gif/animated", () => {
  const skipped = [
    { source: "a.gif", bytes: 900_000, reason: "animated GIF (…)", animatedGif: true },
    { source: "b.webp", bytes: 10, reason: "animated image", animatedGif: false },
    { source: "c.jpg", bytes: 10, reason: "unreadable or corrupt image", animatedGif: false },
  ];

  it("flags animated GIFs only", async () => {
    const f = await gifAnimated.check(context({ skipped }));
    expect(f.map((x) => x.source)).toEqual(["a.gif"]);
    expect(f[0]).not.toHaveProperty("savingsBytes");
  });

  it("tells the user to install ffmpeg, with the command, when it is missing (§4)", async () => {
    const f = await gifAnimated.check(
      context({ skipped, ffmpeg: { found: false, installHint: "brew install ffmpeg" } }),
    );
    expect(f[0]!.message).toMatch(/Needs ffmpeg: brew install ffmpeg/);
    const have = await gifAnimated.check(context({ skipped }));
    expect(have[0]!.message).not.toMatch(/Needs ffmpeg/);
  });
});

describe("gif/static", () => {
  it("flags single-frame GIFs with an estimate", async () => {
    const f = await gifStatic.check(
      context({
        images: [image({ analysis: { format: "gif" }, bytes: 6000, estimate: estimate(300) })],
      }),
    );
    expect(f).toEqual([expect.objectContaining({ ruleId: "gif/static", savingsBytes: 5700 })]);
  });

  it("ignores other formats and covered GIFs", async () => {
    expect(await gifStatic.check(context({ images: [image()] }))).toEqual([]);
    const done = image({ analysis: { format: "gif" }, cache: { kind: "hit" } });
    expect(await gifStatic.check(context({ images: [done] }))).toEqual([]);
  });
});

describe("project/duplicate", () => {
  it("groups identical content across images and svgs, keeping the first path", async () => {
    const same = "c".repeat(64);
    const f = await duplicate.check(
      context({
        images: [
          image({ source: "z/copy.png", sha256: same, bytes: 1000 }),
          image({ source: "a/orig.png", sha256: same, bytes: 1000 }),
          image({ source: "other.png", sha256: "d".repeat(64) }),
        ],
        svgs: [svg({ source: "m/copy2.png.svg", sha256: same, bytes: 1000 })],
      }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      source: "a/orig.png",
      savingsBytes: 2000,
      message: "identical content in 2 other files: m/copy2.png.svg, z/copy.png",
    });
  });

  it("reports nothing when every file is unique", async () => {
    const ctx = context({
      images: [image({ source: "a.jpg" }), image({ source: "b.jpg", sha256: "e".repeat(64) })],
    });
    expect(await duplicate.check(ctx)).toEqual([]);
  });
});

describe("project/unreferenced", () => {
  const refs = (...names: string[]) => new Set(names);

  it("flags images whose file name appears nowhere, case-insensitively", async () => {
    const f = await unreferenced.check(
      context({
        references: refs("used.jpg", "logo.svg"),
        images: [image({ source: "img/used.jpg" }), image({ source: "img/Orphan.JPG" })],
        svgs: [svg({ source: "icons/Logo.svg" }), svg({ source: "icons/old.svg" })],
        skipped: [
          { source: "img/loader.gif", bytes: 5, reason: "animated GIF", animatedGif: true },
        ],
      }),
    );
    expect(f.map((x) => x.source).sort()).toEqual([
      "icons/old.svg",
      "img/Orphan.JPG",
      "img/loader.gif",
    ]);
    expect(f.every((x) => x.severity === "info")).toBe(true);
  });

  it("does nothing when the reference scan was not run", async () => {
    expect(await unreferenced.check(context({ references: null, images: [image()] }))).toEqual([]);
  });
});

describe("project/over-budget", () => {
  const manifest = (width: number, bytes: number): Manifest => ({
    version: 2,
    tools: {},
    publicPath: "/_bytecut",
    sources: {
      "img/a.jpg": {
        sha256: "a".repeat(64),
        bytes: 100_000,
        width: 2000,
        height: 1000,
        preset: "photo",
        outputs: [
          {
            path: "x-640.avif",
            url: "",
            format: "avif",
            width: 640,
            height: 1,
            bytes: 1_000,
            sha256: "b".repeat(64),
            lossless: false,
            quality: 60,
            effort: 4,
            encoder: "e",
            status: "written",
          },
          {
            path: "x-1920.avif",
            url: "",
            format: "avif",
            width,
            height: 1,
            bytes,
            sha256: "c".repeat(64),
            lossless: false,
            quality: 60,
            effort: 4,
            encoder: "e",
            status: "written",
          },
          {
            path: "x-1920.webp",
            url: "",
            format: "webp",
            width,
            height: 1,
            bytes: bytes + 500,
            sha256: "d".repeat(64),
            lossless: false,
            quality: 78,
            effort: 4,
            encoder: "e",
            status: "written",
          },
        ],
      },
    },
  });

  it("is inert without budgets", async () => {
    expect(await overBudget.check(context({ images: [image({ bytes: 9_999_999 })] }))).toEqual([]);
  });

  it("flags files and the total as errors", async () => {
    const f = await overBudget.check(
      context({
        images: [image({ source: "a.jpg", bytes: 300 }), image({ source: "b.jpg", bytes: 900 })],
        budgets: { maxFileBytes: 500, maxTotalBytes: 1000 },
      }),
    );
    expect(f.map((x) => [x.source ?? "(total)", x.severity])).toEqual([
      ["b.jpg", "error"],
      ["(total)", "error"],
    ]);
  });

  it("measures what is served: the widest best output once optimized, the source before", () => {
    const optimized = image({ source: "img/a.jpg", cache: { kind: "hit" } });
    expect(servedBytes(optimized, context({ manifest: manifest(1920, 20_000) }))).toBe(20_000);
    expect(
      servedBytes(
        image({ source: "img/a.jpg", bytes: 77 }),
        context({ manifest: manifest(1920, 20_000) }),
      ),
    ).toBe(77);
  });

  it("an optimized image under budget does not trip it even though its source is huge", async () => {
    const f = await overBudget.check(
      context({
        images: [image({ source: "img/a.jpg", bytes: 5_000_000, cache: { kind: "hit" } })],
        manifest: manifest(1920, 20_000),
        budgets: { maxFileBytes: 50_000 },
      }),
    );
    expect(f).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildCatalog,
  IMAGE_TARGETS,
  VIDEO_TARGET_CRF_OFFSET,
} from "../../../src/core/config/presets.js";
import { BUILTIN_CATALOG } from "../../../src/core/presets/catalog.js";
import { PHOTO_PRESET } from "../../../src/core/presets/photo.js";
import { CONTENT_VIDEO_PRESET } from "../../../src/core/presets/video.js";
import type { PresetConfig } from "../../../src/core/config/schema.js";

const fails = (defs: Record<string, PresetConfig>) => {
  try {
    buildCatalog(defs);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected presets to be rejected");
};

describe("buildCatalog", () => {
  it("with no presets is exactly the built-ins", () => {
    const catalog = buildCatalog(undefined);
    expect(catalog.image).toEqual(BUILTIN_CATALOG.image);
    expect(catalog.video).toEqual(BUILTIN_CATALOG.video);
  });

  it("never mutates the built-ins", () => {
    const before = JSON.stringify(BUILTIN_CATALOG);
    buildCatalog({
      photo: { widths: [10_00], target: "low" },
      x: { extends: "content-video", target: "high" },
    });
    expect(JSON.stringify(BUILTIN_CATALOG)).toBe(before);
  });

  it("extends a built-in and overrides only what is named", () => {
    const { image, root, origin } = buildCatalog({
      thumbs: { extends: "photo", widths: [480, 240, 240], formats: ["webp"] },
    });
    // Listing widths replaces the longest-side cap rather than adding to it.
    expect(image.thumbs).toEqual({
      ...PHOTO_PRESET,
      maxEdge: undefined,
      name: "thumbs",
      widths: [240, 480],
      formats: ["webp"],
    });
    expect(root.thumbs).toBe("photo");
    expect(origin.thumbs).toEqual({ chain: ["photo", "thumbs"], overrides: ["widths", "formats"] });
  });

  it("resolves extends chains regardless of declaration order", () => {
    const defs: Record<string, PresetConfig> = {
      c: { extends: "b", priority: true },
      b: { extends: "a", widths: [320] },
      a: { extends: "hero", target: "low" },
    };
    const { image, root, origin } = buildCatalog(defs);
    expect(image.c).toMatchObject({
      widths: [320],
      priority: true,
      encoders: {
        avif: { quality: IMAGE_TARGETS.low.avif },
        webp: { quality: IMAGE_TARGETS.low.webp },
      },
    });
    expect(root.c).toBe("hero");
    expect(origin.c!.chain).toEqual(["hero", "a", "b", "c"]);
  });

  it("changes a built-in in place when a preset has its name and no extends", () => {
    const { image, root } = buildCatalog({ photo: { widths: [800] }, mine: { extends: "photo" } });
    expect(image.photo!.widths).toEqual([800]);
    // And presets extending it see the change, whichever is declared first.
    expect(image.mine!.widths).toEqual([800]);
    expect(root.photo).toBe("photo");
  });

  it("applies `target`, then lets explicit quality win", () => {
    const { image } = buildCatalog({
      a: { extends: "photo", target: "high" },
      b: { extends: "photo", target: "high", quality: { avif: 50 } },
      c: { extends: "photo", target: "lossless" },
    });
    expect(image.a!.encoders.avif.quality).toBe(IMAGE_TARGETS.high.avif);
    expect(image.b!.encoders.avif.quality).toBe(50);
    expect(image.b!.encoders.webp.quality).toBe(IMAGE_TARGETS.high.webp);
    expect(image.c!.lossless).toBe(true);
  });

  it("maps a video target to a CRF offset and lets explicit crf win", () => {
    const { video } = buildCatalog({
      low: { extends: "content-video", target: "low" },
      high: { extends: "content-video", target: "high" },
      exact: { extends: "content-video", target: "low", crf: { av1: 20 } },
      quiet: { extends: "content-video", audio: "strip", maxWidth: 1280, codecs: ["h264"] },
    });
    expect(video.low!.crf.av1).toBe(CONTENT_VIDEO_PRESET.crf.av1 + VIDEO_TARGET_CRF_OFFSET.low);
    expect(video.high!.crf.h264).toBe(CONTENT_VIDEO_PRESET.crf.h264 + VIDEO_TARGET_CRF_OFFSET.high);
    expect(video.exact!.crf).toEqual({ av1: 20, h264: CONTENT_VIDEO_PRESET.crf.h264 + 4 });
    expect(video.quiet).toMatchObject({ audio: "strip", maxWidth: 1280, codecs: ["h264"] });
  });

  it("keeps the more conservative default: audio stays unless asked", () => {
    expect(buildCatalog({ v: { extends: "content-video" } }).video.v!.audio).toBe("keep");
  });

  it("turns a perceptual target and size cap into the preset's search", () => {
    const { image } = buildCatalog({
      crisp: { extends: "hero", ssimulacra2: 82, floor: 65, maxSize: 150_000 },
      plain: { extends: "photo", ssimulacra2: 70 },
    });
    expect(image.crisp!.search).toEqual({
      metric: "ssimulacra2",
      target: 82,
      floor: 65,
      maxBytes: 150_000,
    });
    expect(image.plain!.search).toEqual({ metric: "ssimulacra2", target: 70 });
    expect(image.hero!.search).toBeUndefined();
    // It is inherited by presets that extend one with a target.
    const inherited = buildCatalog({
      a: { extends: "photo", ssimulacra2: 75 },
      b: { extends: "a" },
    });
    expect(inherited.image.b!.search).toEqual({ metric: "ssimulacra2", target: 75 });
  });

  it("turns a perceptual target on a video preset into its search", () => {
    const { video } = buildCatalog({
      s: { extends: "content-video", ssimulacra2: 80 },
      v: { extends: "background-video", vmaf: 92 },
      inherits: { extends: "v" },
    });
    expect(video.s!.search).toEqual({ metric: "ssimulacra2", target: 80 });
    expect(video.v!.search).toEqual({ metric: "vmaf", target: 92 });
    expect(video.inherits!.search).toEqual({ metric: "vmaf", target: 92 });
    expect(video["content-video"]!.search).toBeUndefined();
  });

  it("keeps the size cap and floor image-only, and vmaf video-only", () => {
    expect(fails({ v: { extends: "content-video", ssimulacra2: 80, floor: 60 } })).toMatch(
      /"v" extends a video preset, so `floor` \(an image setting\) does not apply/,
    );
    expect(fails({ v: { extends: "content-video", maxSize: 1000 } })).toMatch(
      /"v" extends a video preset, so `maxSize` \(an image setting\) does not apply/,
    );
    expect(fails({ p: { extends: "photo", vmaf: 90 } })).toMatch(
      /"p" extends an image preset, so `vmaf` \(a video metric\) does not apply/,
    );
  });

  it("lists the metric among the settings a preset changes", () => {
    const { origin } = buildCatalog({ v: { extends: "content-video", vmaf: 92 } });
    expect(origin.v!.overrides).toContain("vmaf");
  });

  it("rejects an unnamed base, an unknown base (with a hint) and `svg`", () => {
    expect(fails({ mine: { widths: [100] } })).toMatch(/"mine" must say what it extends/);
    expect(fails({ mine: { extends: "phoot" } })).toMatch(
      /unknown preset "phoot" \(did you mean "photo"\?\)/,
    );
    expect(fails({ mine: { extends: "svg" } })).toMatch(
      /"mine" extends "svg", which has no output yet/,
    );
  });

  it("rejects cycles and names the loop", () => {
    expect(fails({ a: { extends: "b" }, b: { extends: "a" } })).toMatch(/extends cycle: a → b → a/);
  });

  it("rejects settings that do not belong to the preset's kind", () => {
    expect(fails({ v: { extends: "content-video", widths: [100] } })).toMatch(
      /"v" extends a video preset, so `widths`/,
    );
    expect(fails({ i: { extends: "photo", audio: "strip" } })).toMatch(
      /"i" extends an image preset, so `audio`/,
    );
    expect(fails({ v: { extends: "content-video", target: "lossless" } })).toMatch(
      /lossless.*video/,
    );
  });
});

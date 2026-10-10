import { describe, expect, it } from "vitest";
import { classify, FLAT_COLOR_LIMIT, ICON_MAX_EDGE } from "../../../src/core/classify/classify.js";
import { fakeAnalysis } from "../../helpers.js";

const photo = { colorCount: 900, sampleSize: 4096 };
const flat = { colorCount: 4, sampleSize: 4096 };

describe("classify", () => {
  describe("icon", () => {
    it("flat art up to ICON_MAX_EDGE is an icon", () => {
      const c = classify(
        "a/logo.png",
        fakeAnalysis({ ...flat, width: 600, height: 400, format: "png" }),
      );
      expect(c).toMatchObject({ preset: "icon", confidence: "high" });
      expect(c.reason).toMatch(/flat art/);
    });

    it("transparency makes the verdict high-confidence", () => {
      const c = classify(
        "a/thing.png",
        fakeAnalysis({ ...flat, width: 900, height: 900, alphaUsed: true, hasAlpha: true }),
      );
      expect(c).toMatchObject({ preset: "icon", confidence: "high" });
    });

    it("a large flat image is not capped at icon widths", () => {
      const c = classify(
        "a/diagram.png",
        fakeAnalysis({ ...flat, width: ICON_MAX_EDGE + 1, height: 600 }),
      );
      expect(c.preset).not.toBe("icon");
      expect(c.preset).toBe("photo");
    });

    it("uses the colour limit as the boundary", () => {
      const at = classify(
        "x.png",
        fakeAnalysis({ width: 100, height: 100, colorCount: FLAT_COLOR_LIMIT, sampleSize: 4096 }),
      );
      const over = classify(
        "x.png",
        fakeAnalysis({
          width: 100,
          height: 100,
          colorCount: FLAT_COLOR_LIMIT + 1,
          sampleSize: 4096,
        }),
      );
      expect(at.preset).toBe("icon");
      expect(over.preset).toBe("photo");
    });

    it("a small image named like an icon is an icon even with many colours", () => {
      const c = classify("img/app-icon.png", fakeAnalysis({ ...photo, width: 128, height: 128 }));
      expect(c).toMatchObject({ preset: "icon", confidence: "medium" });
    });

    it("an icon-ish name on a big photo is not enough", () => {
      expect(
        classify("img/logo.jpg", fakeAnalysis({ ...photo, width: 3000, height: 2000 })).preset,
      ).not.toBe("icon");
    });

    it("does not treat an unsampled image as flat", () => {
      const c = classify(
        "x.jpg",
        fakeAnalysis({ colorCount: 0, sampleSize: 0, width: 100, height: 100 }),
      );
      expect(c.preset).toBe("photo");
    });
  });

  describe("hero", () => {
    it.each([
      "hero.jpg",
      "img/Hero-Image.jpg",
      "home_banner.jpg",
      "cover.png",
      "site-header.jpg",
      "splash.jpg",
    ])("recognises the name %s", (name) => {
      const c = classify(name, fakeAnalysis({ ...photo, width: 1200, height: 800 }));
      expect(c).toMatchObject({ preset: "hero", confidence: "high" });
    });

    it("does not match inside other words", () => {
      for (const name of ["heron.jpg", "discover.jpg", "recovery.jpg", "headerless.jpg"]) {
        expect(classify(name, fakeAnalysis({ ...photo, width: 1200, height: 800 })).preset).toBe(
          "photo",
        );
      }
    });

    it("a large wide image is a medium-confidence hero", () => {
      const c = classify("a/landscape.jpg", fakeAnalysis({ ...photo, width: 2600, height: 1400 }));
      expect(c).toMatchObject({ preset: "hero", confidence: "medium" });
    });

    it("a large but square image is not", () => {
      expect(
        classify("a/b.jpg", fakeAnalysis({ ...photo, width: 2400, height: 2400 })).preset,
      ).toBe("photo");
    });
  });

  describe("photo", () => {
    it("is the answer for continuous-tone images", () => {
      expect(
        classify("a/b.jpg", fakeAnalysis({ ...photo, width: 1400, height: 900 })),
      ).toMatchObject({
        preset: "photo",
        confidence: "high",
      });
    });

    it("falls back conservatively, with low confidence, in the grey zone", () => {
      const c = classify(
        "a/b.png",
        fakeAnalysis({
          colorCount: 100,
          sampleSize: 4096,
          width: 2000,
          height: 1500,
          format: "png",
        }),
      );
      expect(c).toMatchObject({ preset: "photo", confidence: "low" });
    });
  });
});

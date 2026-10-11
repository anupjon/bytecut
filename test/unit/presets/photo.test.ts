import { describe, expect, it } from "vitest";
import { HERO_PRESET } from "../../../src/core/presets/hero.js";
import { PHOTO_PRESET } from "../../../src/core/presets/photo.js";

describe("photo preset", () => {
  it("emits a single JPEG, with the longest side capped at 1920", () => {
    expect(PHOTO_PRESET.name).toBe("photo");
    expect(PHOTO_PRESET.formats).toEqual(["jpg"]);
    expect(PHOTO_PRESET.maxEdge).toBe(1920);
    expect(PHOTO_PRESET.widths).toEqual([]);
  });
  it("has encoder settings for every format", () => {
    for (const format of PHOTO_PRESET.formats) {
      expect(PHOTO_PRESET.encoders[format].quality).toBeGreaterThan(0);
    }
  });
  it("keeps webp and avif settings ready for when a config adds them", () => {
    for (const format of ["jpg", "png", "webp", "avif"] as const) {
      expect(PHOTO_PRESET.encoders[format]).toBeDefined();
    }
  });
  it("hero uses the same single size and format", () => {
    expect(HERO_PRESET.formats).toEqual(["jpg"]);
    expect(HERO_PRESET.maxEdge).toBe(1920);
    expect(HERO_PRESET.widths).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { PHOTO_PRESET } from "../../../src/core/presets/photo.js";

describe("photo preset", () => {
  it("emits AVIF and WebP at 640/1280/1920", () => {
    expect(PHOTO_PRESET.name).toBe("photo");
    expect(PHOTO_PRESET.formats).toEqual(["avif", "webp"]);
    expect(PHOTO_PRESET.widths).toEqual([640, 1280, 1920]);
  });
  it("has encoder settings for every format and ascending widths", () => {
    for (const format of PHOTO_PRESET.formats) {
      expect(PHOTO_PRESET.encoders[format].quality).toBeGreaterThan(0);
    }
    expect([...PHOTO_PRESET.widths].sort((a, b) => a - b)).toEqual(PHOTO_PRESET.widths);
  });
});

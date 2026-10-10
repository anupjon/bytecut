import { describe, expect, it } from "vitest";
import {
  BACKGROUND_VIDEO_PRESET,
  CONTENT_VIDEO_PRESET,
  GIF_TO_VIDEO_PRESET,
  VIDEO_PRESETS,
  getVideoPreset,
} from "../../../src/core/presets/video.js";

describe("video presets", () => {
  it("exports exactly the three built-ins from the spec", () => {
    expect(Object.keys(VIDEO_PRESETS).sort()).toEqual([
      "background-video",
      "content-video",
      "gif-to-video",
    ]);
    for (const [name, preset] of Object.entries(VIDEO_PRESETS)) expect(preset.name).toBe(name);
  });

  it("every preset produces AV1 first and an H.264 fallback, with a poster", () => {
    for (const preset of Object.values(VIDEO_PRESETS)) {
      expect(preset.codecs).toEqual(["av1", "h264"]);
      expect(preset.crf.av1).toBeGreaterThan(0);
      expect(preset.crf.h264).toBeGreaterThan(0);
      expect(preset.poster.at).toBeGreaterThan(0);
      expect(preset.poster.at).toBeLessThan(1);
    }
  });

  it("background strips audio and caps resolution/fps; content keeps all three (§6.8)", () => {
    expect(BACKGROUND_VIDEO_PRESET).toMatchObject({ audio: "strip", maxWidth: 1920, maxFps: 30 });
    expect(CONTENT_VIDEO_PRESET).toMatchObject({ audio: "keep", maxWidth: null, maxFps: null });
  });

  it("gif-to-video is silent", () => {
    expect(GIF_TO_VIDEO_PRESET.audio).toBe("strip");
  });

  it("content is encoded at higher quality (lower crf) than background", () => {
    expect(CONTENT_VIDEO_PRESET.crf.av1).toBeLessThan(BACKGROUND_VIDEO_PRESET.crf.av1);
    expect(CONTENT_VIDEO_PRESET.crf.h264).toBeLessThan(BACKGROUND_VIDEO_PRESET.crf.h264);
  });

  it("uses SVT-AV1 preset 6 and a slow x264 preset (confirmed default)", () => {
    for (const preset of Object.values(VIDEO_PRESETS)) {
      expect(preset.speed).toEqual({ av1: "6", h264: "slow" });
    }
  });

  it("looks presets up by name", () => {
    expect(getVideoPreset("content-video")).toBe(CONTENT_VIDEO_PRESET);
    expect(getVideoPreset("photo")).toBeUndefined();
  });
});

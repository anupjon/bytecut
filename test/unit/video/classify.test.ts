import { describe, expect, it } from "vitest";
import { BACKGROUND_MAX_SECONDS, classifyVideo } from "../../../src/core/classify/video.js";
import { probeOf } from "../../video-helpers.js";

describe("classifyVideo", () => {
  it("a short silent clip is a background video", () => {
    const c = classifyVideo(
      "public/clips/intro.mp4",
      probeOf({ hasAudio: false, durationSec: 12 }),
    );
    expect(c).toMatchObject({ preset: "background-video", confidence: "medium" });
    expect(c.reason).toMatch(/silent 12s clip/);
  });

  it("a backdrop-like name raises confidence", () => {
    const c = classifyVideo("public/hero-loop.mp4", probeOf({ hasAudio: false, durationSec: 8 }));
    expect(c).toMatchObject({ preset: "background-video", confidence: "high" });
  });

  it.each([
    "bg",
    "background",
    "hero",
    "loop",
    "ambient",
    "banner",
    "header",
    "texture",
    "cover",
    "splash",
  ])("recognises the backdrop name token %s", (token) => {
    const c = classifyVideo(`media/${token}-1.mp4`, probeOf({ hasAudio: true, durationSec: 10 }));
    expect(c.preset).toBe("background-video");
  });

  it("a named backdrop WITH audio is still a backdrop, and says its audio goes", () => {
    const c = classifyVideo("media/hero.mp4", probeOf({ hasAudio: true, durationSec: 10 }));
    expect(c).toMatchObject({ preset: "background-video", confidence: "medium" });
    expect(c.reason).toMatch(/audio track will be removed/);
  });

  it("an unnamed clip with audio keeps it (§6.8)", () => {
    const c = classifyVideo("media/interview.mp4", probeOf({ hasAudio: true, durationSec: 10 }));
    expect(c).toMatchObject({ preset: "content-video", confidence: "high" });
  });

  it("a long clip is content even if silent or named like a backdrop", () => {
    const long = BACKGROUND_MAX_SECONDS + 1;
    expect(classifyVideo("m/loop.mp4", probeOf({ hasAudio: true, durationSec: long })).preset).toBe(
      "content-video",
    );
    const silent = classifyVideo(
      "m/screencast.mp4",
      probeOf({ hasAudio: false, durationSec: long }),
    );
    expect(silent).toMatchObject({ preset: "content-video", confidence: "low" });
  });

  it("does not match tokens inside other words", () => {
    for (const name of ["background-music-lesson", "cover-me"]) {
      void name;
    }
    expect(classifyVideo("m/heroic.mp4", probeOf({ hasAudio: true })).preset).toBe("content-video");
    expect(classifyVideo("m/subgroup.mp4", probeOf({ hasAudio: true })).preset).toBe(
      "content-video",
    );
  });

  it("treats an unknown duration as not short", () => {
    expect(classifyVideo("m/x.mp4", probeOf({ hasAudio: false, durationSec: 0 })).preset).toBe(
      "content-video",
    );
  });
});

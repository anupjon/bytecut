import { describe, expect, it } from "vitest";
import { videoAudioInBackground } from "../../../src/core/audit/rules/video-audio-in-background.js";
import { videoHighBitrate } from "../../../src/core/audit/rules/video-high-bitrate.js";
import { videoHighFps } from "../../../src/core/audit/rules/video-high-fps.js";
import { videoNoFallback } from "../../../src/core/audit/rules/video-no-fallback.js";
import { videoNoFaststart } from "../../../src/core/audit/rules/video-no-faststart.js";
import { videoNoModernCodec } from "../../../src/core/audit/rules/video-no-modern-codec.js";
import { videoNoPoster } from "../../../src/core/audit/rules/video-no-poster.js";
import { videoOversizedResolution } from "../../../src/core/audit/rules/video-oversized-resolution.js";
import { context, video } from "../../audit-helpers.js";

const covered = { cache: { kind: "hit" } as const };
const background = {
  classification: { preset: "background-video", confidence: "high", reason: "t" } as const,
};

describe("rule metadata (§5)", () => {
  it.each([
    [videoNoModernCodec, "video/no-modern-codec", "warn"],
    [videoNoFallback, "video/no-fallback", "warn"],
    [videoOversizedResolution, "video/oversized-resolution", "warn"],
    [videoHighFps, "video/high-fps", "warn"],
    [videoHighBitrate, "video/high-bitrate", "warn"],
    [videoAudioInBackground, "video/audio-in-background", "warn"],
    [videoNoFaststart, "video/no-faststart", "warn"],
    [videoNoPoster, "video/no-poster", "info"],
  ] as const)("%s", (rule, id, severity) => {
    expect(rule).toMatchObject({
      id,
      category: "video",
      defaultSeverity: severity,
      fix: "optimize",
    });
  });
});

describe("video/no-modern-codec", () => {
  it("flags an H.264 source and carries the estimate", async () => {
    const f = await videoNoModernCodec.check(context({ videos: [video({ bytes: 1_000_000 })] }));
    expect(f).toEqual([
      expect.objectContaining({
        ruleId: "video/no-modern-codec",
        message: "H.264 source has no AV1 output",
        current: 1_000_000,
        estimated: 200_000,
        savingsBytes: 800_000,
      }),
    ]);
  });

  it("ignores AV1/VP9 sources, GIFs, covered videos", async () => {
    const cases = [
      video({ probe: { videoCodec: "av1" } }),
      video({ probe: { videoCodec: "vp9" } }),
      video({ isGif: true }),
      video({ ...covered }),
    ];
    for (const c of cases)
      expect(await videoNoModernCodec.check(context({ videos: [c] }))).toEqual([]);
  });

  it("stays quiet when re-encoding would not help (§6.7), but flags when there is no estimate", async () => {
    const tiny = video({
      bytes: 5_000,
      estimate: { best: { codec: "av1", bytes: 4_900, basis: "exact" }, perCodec: [] },
    });
    expect(await videoNoModernCodec.check(context({ videos: [tiny] }))).toEqual([]);
    const unknown = video({ estimate: null });
    const f = await videoNoModernCodec.check(context({ videos: [unknown] }));
    expect(f).toHaveLength(1);
    expect(f[0]).not.toHaveProperty("savingsBytes");
  });
});

describe("video/no-fallback", () => {
  it("flags sources only some browsers can play", async () => {
    for (const codec of ["av1", "vp9", "hevc"]) {
      const f = await videoNoFallback.check(
        context({ videos: [video({ probe: { videoCodec: codec } })] }),
      );
      expect(f, codec).toHaveLength(1);
    }
    const f = await videoNoFallback.check(
      context({ videos: [video({ probe: { videoCodec: "hevc" } })] }),
    );
    expect(f[0]!.message).toMatch(/HEVC is not playable everywhere/);
  });

  it("ignores H.264, GIFs and covered videos", async () => {
    const cases = [
      video(),
      video({ isGif: true, probe: { videoCodec: "gif" } }),
      video({ ...covered, probe: { videoCodec: "av1" } }),
    ];
    for (const c of cases)
      expect(await videoNoFallback.check(context({ videos: [c] }))).toEqual([]);
  });
});

describe("video/oversized-resolution", () => {
  it("is a warning when the preset would cap it, an info when content keeps its resolution", async () => {
    const bg = video({ ...background, probe: { width: 3840, height: 2160 } });
    const content = video({ probe: { width: 3840, height: 2160 } });
    const f = await videoOversizedResolution.check(context({ videos: [bg, content] }));
    expect(f.map((x) => x.severity)).toEqual(["warn", "info"]);
    expect(f[0]!.message).toMatch(/exceeds 1920px; outputs are capped/);
    expect(f[1]!.message).toMatch(/kept as-is because it looks like content/);
  });

  it("uses the longer edge and honours maxWidth; ignores covered videos", async () => {
    const portrait = video({ ...background, probe: { width: 1080, height: 2400 } });
    expect(await videoOversizedResolution.check(context({ videos: [portrait] }))).toHaveLength(1);
    const exact = video({ probe: { width: 1920, height: 1080 } });
    expect(await videoOversizedResolution.check(context({ videos: [exact] }))).toEqual([]);
    const opt = context({
      videos: [exact],
      opts: { "video/oversized-resolution": { maxWidth: 1280 } },
    });
    expect(await videoOversizedResolution.check(opt)).toHaveLength(1);
    expect(
      await videoOversizedResolution.check(
        context({ videos: [video({ ...covered, probe: { width: 4000 } })] }),
      ),
    ).toEqual([]);
  });
});

describe("video/high-fps", () => {
  it("flags backdrops above the cap, and reports content as info only", async () => {
    const bg = video({ ...background, probe: { fps: 60 } });
    const content = video({ probe: { fps: 60 } });
    const f = await videoHighFps.check(context({ videos: [bg, content] }));
    expect(f.map((x) => x.severity)).toEqual(["warn", "info"]);
    expect(f[0]!.message).toMatch(/60 fps is more than a backdrop needs; outputs are capped at 30/);
  });

  it("tolerates 30.0 and NTSC rates, honours maxFps, skips covered", async () => {
    for (const fps of [24, 30, 30.0001]) {
      expect(
        await videoHighFps.check(context({ videos: [video({ ...background, probe: { fps } })] })),
      ).toEqual([]);
    }
    const opt = context({
      videos: [video({ ...background, probe: { fps: 30 } })],
      opts: { "video/high-fps": { maxFps: 24 } },
    });
    expect(await videoHighFps.check(opt)).toHaveLength(1);
    expect(
      await videoHighFps.check(
        context({ videos: [video({ ...covered, ...background, probe: { fps: 60 } })] }),
      ),
    ).toEqual([]);
  });
});

describe("video/high-bitrate", () => {
  // 1280x720 at 30 fps: 27.6M pixels/s. 8 Mbps is 0.29 bits per pixel.
  it("flags a bitrate that is high for its resolution and frame rate", async () => {
    const heavy = video({ bytes: 5_000_000, probe: { bitrate: 8_000_000 } });
    const f = await videoHighBitrate.check(context({ videos: [heavy] }));
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toBe("0.29 bits per pixel per frame (over 0.2)");
  });

  it("is independent of resolution: the same bpp at 4K and 360p gives the same verdict", async () => {
    const hd = video({
      bytes: 5_000_000,
      probe: { width: 640, height: 360, fps: 30, bitrate: 1_000_000 },
    });
    const uhd = video({
      bytes: 5_000_000,
      probe: { width: 3840, height: 2160, fps: 30, bitrate: 36_000_000 },
    });
    // Both are ~0.145 bpp: under the threshold.
    expect(await videoHighBitrate.check(context({ videos: [hd, uhd] }))).toEqual([]);
  });

  it("ignores small files, unknown bitrates, covered videos; honours options", async () => {
    expect(
      await videoHighBitrate.check(
        context({ videos: [video({ bytes: 1_000, probe: { bitrate: 8_000_000 } })] }),
      ),
    ).toEqual([]);
    expect(
      await videoHighBitrate.check(context({ videos: [video({ probe: { bitrate: null } })] })),
    ).toEqual([]);
    expect(
      await videoHighBitrate.check(
        context({ videos: [video({ ...covered, probe: { bitrate: 9e6 } })] }),
      ),
    ).toEqual([]);
    const opt = context({
      videos: [video({ bytes: 5_000_000, probe: { bitrate: 4_000_000 } })],
      opts: { "video/high-bitrate": { maxBitsPerPixel: 0.1 } },
    });
    expect(await videoHighBitrate.check(opt)).toHaveLength(1);
  });
});

describe("video/audio-in-background", () => {
  it("flags a backdrop that carries audio", async () => {
    const f = await videoAudioInBackground.check(context({ videos: [video({ ...background })] }));
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/outputs drop it/);
  });

  it("ignores silent backdrops, content with audio, and covered videos", async () => {
    const cases = [
      video({ ...background, probe: { hasAudio: false } }),
      video({}),
      video({ ...background, ...covered }),
    ];
    for (const c of cases)
      expect(await videoAudioInBackground.check(context({ videos: [c] }))).toEqual([]);
  });
});

describe("video/no-faststart", () => {
  it("flags only MP4s whose moov comes last", async () => {
    const f = await videoNoFaststart.check(context({ videos: [video({ faststart: false })] }));
    expect(f).toHaveLength(1);
    for (const faststart of [true, null]) {
      expect(await videoNoFaststart.check(context({ videos: [video({ faststart })] }))).toEqual([]);
    }
    expect(
      await videoNoFaststart.check(context({ videos: [video({ faststart: false, ...covered })] })),
    ).toEqual([]);
  });
});

describe("video/no-poster", () => {
  it("flags videos without a sibling poster, as info", async () => {
    const f = await videoNoPoster.check(context({ videos: [video({ hasPoster: false })] }));
    expect(f).toEqual([expect.objectContaining({ severity: "info", source: "media/a.mp4" })]);
  });

  it("ignores videos that have one, and covered ones", async () => {
    expect(await videoNoPoster.check(context({ videos: [video({ hasPoster: true })] }))).toEqual(
      [],
    );
    expect(await videoNoPoster.check(context({ videos: [video({ ...covered })] }))).toEqual([]);
  });
});

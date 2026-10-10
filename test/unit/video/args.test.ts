import { describe, expect, it } from "vitest";
import {
  buildEncodeArgs,
  buildFrameArgs,
  buildSampleArgs,
  encoderArgs,
  evenDown,
  needsFpsCap,
  outputWidth,
  progressFraction,
  videoFilter,
} from "../../../src/core/video/args.js";
import type { VideoEncodeRequest } from "../../../src/core/video/types.js";
import type { VideoProbe } from "../../../src/core/video/probe.js";

const probe = (over: Partial<VideoProbe> = {}): VideoProbe => ({
  durationSec: 10,
  width: 1920,
  height: 1080,
  fps: 60,
  videoCodec: "h264",
  pixelFormat: "yuv420p",
  bitrate: 8_000_000,
  hasAudio: true,
  audioCodec: "aac",
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  ...over,
});

const request = (over: Partial<VideoEncodeRequest> = {}): VideoEncodeRequest => ({
  source: "/p/in.mp4",
  output: "/out/.in.mp4.abc.tmp",
  encoder: "libsvtav1",
  crf: 35,
  speed: "6",
  maxWidth: null,
  maxFps: null,
  audio: "keep",
  audioBitrate: "96k",
  probe: probe(),
  ...over,
});

describe("dimensions", () => {
  it("rounds down to even and never upscales", () => {
    expect(evenDown(1281)).toBe(1280);
    expect(evenDown(1)).toBe(2);
    expect(outputWidth(1920, null)).toBe(1920);
    expect(outputWidth(1921, null)).toBe(1920);
    expect(outputWidth(1920, 1280)).toBe(1280);
    expect(outputWidth(640, 1920)).toBe(640);
    expect(outputWidth(1000, 1281)).toBe(1000);
  });

  it("applies a fps cap only to sources above it", () => {
    expect(needsFpsCap({ fps: 60 }, 30)).toBe(true);
    expect(needsFpsCap({ fps: 30 }, 30)).toBe(false);
    expect(needsFpsCap({ fps: 30.0001 }, 30)).toBe(false);
    expect(needsFpsCap({ fps: 24 }, 30)).toBe(false);
    expect(needsFpsCap({ fps: 120 }, null)).toBe(false);
  });

  it("builds the filter chain in order: fps, scale, pixel format", () => {
    expect(videoFilter({ width: 3840, fps: 60 }, 1920, 30)).toBe(
      "fps=30,scale=1920:-2:flags=lanczos,format=yuv420p",
    );
    expect(videoFilter({ width: 800, fps: 24 }, 1920, 30)).toBe(
      "scale=800:-2:flags=lanczos,format=yuv420p",
    );
  });
});

describe("encoder arguments", () => {
  it("covers each encoder", () => {
    expect(encoderArgs("libsvtav1", 35, "6")).toEqual([
      "-c:v",
      "libsvtav1",
      "-crf",
      "35",
      "-preset",
      "6",
    ]);
    expect(encoderArgs("libx264", 26, "slow")).toEqual([
      "-c:v",
      "libx264",
      "-crf",
      "26",
      "-preset",
      "slow",
    ]);
    const aom = encoderArgs("libaom-av1", 35, "6");
    expect(aom).toContain("-b:v");
    expect(aom[aom.indexOf("-b:v") + 1]).toBe("0");
    expect(aom).toContain("-cpu-used");
  });
});

describe("buildEncodeArgs", () => {
  const args = (over?: Partial<VideoEncodeRequest>) => buildEncodeArgs(request(over));
  const after = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

  it("is an argument array with the source read-only and only the reserved output written", () => {
    const a = args();
    expect(a.every((x) => typeof x === "string")).toBe(true);
    expect(after(a, "-i")).toBe("/p/in.mp4");
    expect(a[a.length - 1]).toBe("/out/.in.mp4.abc.tmp");
    expect(a.filter((x) => x === "/p/in.mp4")).toHaveLength(1);
  });

  it("is deterministic: bitexact flags and no source metadata", () => {
    const a = args();
    expect(after(a, "-map_metadata")).toBe("-1");
    expect(after(a, "-fflags")).toBe("+bitexact");
    expect(a).toContain("-flags:v");
    expect(after(a, "-movflags")).toBe("+faststart");
    expect(after(a, "-f")).toBe("mp4");
  });

  it("strips audio when asked, and keeps it (AAC) otherwise", () => {
    expect(args({ audio: "strip" })).toContain("-an");
    expect(args({ audio: "strip" })).not.toContain("-c:a");
    const keep = args({ audio: "keep" });
    expect(keep).not.toContain("-an");
    expect(after(keep, "-c:a")).toBe("aac");
    expect(after(keep, "-b:a")).toBe("96k");
  });

  it("does not map audio from a source that has none", () => {
    const a = args({ audio: "keep", probe: probe({ hasAudio: false }) });
    expect(a).not.toContain("0:a:0");
    expect(a).toContain("-an");
  });

  it("asks for machine-readable progress", () => {
    const a = args();
    expect(after(a, "-progress")).toBe("pipe:1");
    expect(a).toContain("-nostats");
    expect(a).toContain("-nostdin");
  });

  it("applies the resolution and fps caps", () => {
    const a = args({ maxWidth: 1280, maxFps: 30 });
    expect(after(a, "-vf")).toBe("fps=30,scale=1280:-2:flags=lanczos,format=yuv420p");
  });
});

describe("buildSampleArgs / buildFrameArgs", () => {
  it("encodes a clip to a raw stream on stdout, with no audio and no file", () => {
    const base = {
      source: "/p/in.mp4",
      crf: 35,
      speed: "6",
      maxWidth: null,
      maxFps: null,
      startSec: 4,
      durationSec: 1.5,
      probe: probe(),
    };
    const av1 = buildSampleArgs({ ...base, encoder: "libsvtav1" });
    expect(av1.slice(-3)).toEqual(["-f", "ivf", "pipe:1"]);
    expect(av1).toContain("-an");
    expect(av1[av1.indexOf("-ss") + 1]).toBe("4");
    expect(av1[av1.indexOf("-t") + 1]).toBe("1.5");
    // -ss before -i: fast input seek.
    expect(av1.indexOf("-ss")).toBeLessThan(av1.indexOf("-i"));
    const h264 = buildSampleArgs({ ...base, encoder: "libx264", speed: "slow" });
    expect(h264.slice(-3)).toEqual(["-f", "h264", "pipe:1"]);
  });

  it("extracts one PNG frame", () => {
    const a = buildFrameArgs("/p/in.mp4", 2.5, 1280, 1920);
    expect(a).toContain("png");
    expect(a[a.indexOf("-frames:v") + 1]).toBe("1");
    expect(a[a.indexOf("-vf") + 1]).toBe("scale=1280:-2:flags=lanczos");
  });
});

describe("progressFraction", () => {
  it("reads the latest out_time_us as a fraction of the duration", () => {
    expect(progressFraction("frame=3\nout_time_us=2500000\nprogress=continue\n", 10)).toBe(0.25);
    expect(progressFraction("out_time_us=1000000\nout_time_us=5000000\n", 10)).toBe(0.5);
  });

  it("clamps and ignores noise", () => {
    expect(progressFraction("out_time_us=99000000\n", 10)).toBe(1);
    expect(progressFraction("progress=end\n", 10)).toBeNull();
    expect(progressFraction("out_time_us=N/A\n", 10)).toBeNull();
    expect(progressFraction("out_time_us=5\n", 0)).toBeNull();
  });
});

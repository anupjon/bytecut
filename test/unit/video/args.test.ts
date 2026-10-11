import { describe, expect, it } from "vitest";
import {
  buildClipEncodeArgs,
  buildEncodeArgs,
  buildFrameArgs,
  buildFramesArgs,
  buildPipedFramesArgs,
  buildSampleArgs,
  buildVmafArgs,
  parseVmafScore,
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

describe("quality search arguments", () => {
  const clip = {
    source: "/p/in.mp4",
    encoder: "libx264" as const,
    crf: 30,
    speed: "slow",
    maxWidth: 1280,
    maxFps: 30,
    startSec: 4,
    durationSec: 2,
    probe: probe(),
  };

  it("encodes a clip to Matroska on stdout, so timestamps survive", () => {
    const a = buildClipEncodeArgs(clip);
    expect(a.slice(-3)).toEqual(["-f", "matroska", "pipe:1"]);
    // Same video settings as the real output, and still no audio and no file.
    expect(a[a.indexOf("-crf") + 1]).toBe("30");
    expect(a).toContain("-an");
    expect(a.filter((x) => x === "-f")).toHaveLength(1);
  });

  it("decodes the reference through the output's own fps cap and scale, then to the score size", () => {
    const a = buildFramesArgs({
      source: "/p/in.mp4",
      startSec: 4,
      durationSec: 2,
      count: 4,
      width: 512,
      height: 288,
      pipeline: { probe: probe(), maxWidth: 1280, maxFps: 30 },
    });
    const vf = a[a.indexOf("-vf") + 1]!;
    expect(vf).toBe(
      "fps=30,scale=1280:-2:flags=lanczos,format=yuv420p,fps=2,scale=512:288:flags=area",
    );
    expect(a.slice(-8)).toEqual([
      "-frames:v",
      "4",
      "-an",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
    expect(a[a.indexOf("-ss") + 1]).toBe("4");
    expect(a[a.indexOf("-t") + 1]).toBe("2");
  });

  it("reads an output as it is, with the same frame selection and size", () => {
    const a = buildFramesArgs({
      source: "/out/v.mp4",
      startSec: 4,
      durationSec: 2,
      count: 4,
      width: 512,
      height: 288,
      pipeline: null,
    });
    expect(a[a.indexOf("-vf") + 1]).toBe("fps=2,scale=512:288:flags=area");
  });

  it("decodes the piped clip with the same selection and size as the reference", () => {
    const a = buildPipedFramesArgs({ ...clip, count: 4, width: 512, height: 288 });
    expect(a.slice(a.indexOf("-f"), a.indexOf("-f") + 4)).toEqual([
      "-f",
      "matroska",
      "-i",
      "pipe:0",
    ]);
    expect(a[a.indexOf("-vf") + 1]).toBe("fps=2,scale=512:288:flags=area");
  });

  it("builds a libvmaf graph: distorted first, reference second, same size", () => {
    const a = buildVmafArgs(clip, 1280, 720);
    const graph = a[a.indexOf("-lavfi") + 1]!;
    expect(graph).toContain("[dist][ref]libvmaf");
    expect(graph).toContain("scale=1280:720");
    expect(graph.indexOf("[0:v]")).toBeLessThan(graph.indexOf("[1:v]"));
    expect(a).toContain("pipe:0");
    expect(a.slice(-3)).toEqual(["-f", "null", "-"]);
  });

  it("judges an existing file instead of piping when given a candidate", () => {
    const a = buildVmafArgs({ ...clip, candidate: "/out/v.mp4" }, 1280, 720);
    expect(a).not.toContain("pipe:0");
    expect(a[a.lastIndexOf("-i") + 1]).toBe("/out/v.mp4");
  });

  it("reads the pooled VMAF score from ffmpeg's log", () => {
    const log = [
      "[libvmaf @ 0x55d] VMAF score: 93.521434",
      "frame=   48 fps=120 q=-0.0 Lsize=N/A time=00:00:02.00",
    ].join("\n");
    expect(parseVmafScore(log)).toBeCloseTo(93.521434, 6);
    expect(parseVmafScore("[libvmaf] VMAF score: 80.1\n[libvmaf] VMAF score: 91.5")).toBe(91.5);
    expect(parseVmafScore("Error: No such filter: 'libvmaf'")).toBeNull();
  });
});

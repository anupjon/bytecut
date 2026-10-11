import { describe, expect, it } from "vitest";
import {
  audioBytes,
  estimateVideo,
  EXACT_MAX_SECONDS,
  SAMPLE_SECONDS,
  sampleStarts,
} from "../../../src/core/audit/estimate-video.js";
import { AnalysisCache } from "../../../src/core/cache/store.js";
import type { PlannedVideoOutput, VideoPlanItem } from "../../../src/core/plan/types.js";
import { ALL_ENCODERS, fakeVideoEngine } from "../../video-helpers.js";

const out = (
  codec: "av1" | "h264",
  over: Partial<PlannedVideoOutput> = {},
): PlannedVideoOutput => ({
  role: "video",
  path: `a-${codec}.mp4`,
  codec,
  width: 1280,
  crf: codec === "av1" ? 32 : 23,
  speed: codec === "av1" ? "6" : "slow",
  maxWidth: null,
  maxFps: null,
  audio: "keep",
  audioBitrate: "128k",
  ...over,
});

const item = (over: Partial<VideoPlanItem> = {}): VideoPlanItem => ({
  source: "a.mp4",
  sourceBytes: 5_000_000,
  sourceSha256: "a".repeat(64),
  sourceWidth: 1280,
  sourceHeight: 720,
  durationSec: 60,
  fps: 30,
  hasAudio: true,
  videoCodec: "h264",
  preset: "content-video",
  outputs: [out("av1"), out("h264")],
  ...over,
});

describe("sampleStarts", () => {
  it("encodes a short clip whole, so its estimate is exact", () => {
    expect(sampleStarts(3)).toEqual([{ startSec: 0, durationSec: 3 }]);
    expect(sampleStarts(EXACT_MAX_SECONDS)).toHaveLength(1);
  });

  it("samples three short windows across a long clip, inside its bounds", () => {
    const s = sampleStarts(100);
    expect(s).toHaveLength(3);
    expect(s.every((w) => w.durationSec === SAMPLE_SECONDS)).toBe(true);
    expect(s.map((w) => w.startSec)).toEqual([...s.map((w) => w.startSec)].sort((a, b) => a - b));
    for (const w of s) {
      expect(w.startSec).toBeGreaterThanOrEqual(0);
      expect(w.startSec + w.durationSec).toBeLessThanOrEqual(100);
    }
  });

  it("keeps windows in range for a clip barely over the exact limit", () => {
    for (const w of sampleStarts(EXACT_MAX_SECONDS + 0.5)) {
      expect(w.startSec + w.durationSec).toBeLessThanOrEqual(EXACT_MAX_SECONDS + 0.5);
      expect(w.startSec).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("audioBytes", () => {
  it("follows the bitrate when audio is kept and present", () => {
    expect(audioBytes(out("av1"), item({ durationSec: 8 }))).toBe(128_000);
  });
  it("is zero when stripped or absent", () => {
    expect(audioBytes(out("av1", { audio: "strip" }), item())).toBe(0);
    expect(audioBytes(out("av1"), item({ hasAudio: false }))).toBe(0);
  });
});

describe("estimateVideo", () => {
  const deps = (
    engine: ReturnType<typeof fakeVideoEngine>["engine"],
    cache = AnalysisCache.empty("t"),
  ) => ({
    engine,
    cache,
    ffmpegVersion: "6.1.1",
  });

  it("scales sampled bytes to the whole duration and adds audio", async () => {
    // 10,000 bytes/s of video, 60 s long → 600,000; plus 128 kbps audio = 960,000.
    const { engine, calls } = fakeVideoEngine({ sampleBytes: (r) => r.durationSec * 10_000 });
    const est = await estimateVideo(item({ outputs: [out("h264")] }), deps(engine), "/p/a.mp4");
    expect(calls.samples).toHaveLength(3);
    expect(est!.best).toMatchObject({
      codec: "h264",
      bytes: 600_000 + 960_000,
      basis: "extrapolated",
    });
  });

  it("reports each sample encode, so a slow estimate can show that it is working", async () => {
    const { engine } = fakeVideoEngine({ sampleBytes: () => 10_000 });
    const steps: Array<{ done: number; total: number }> = [];
    await estimateVideo(item(), { ...deps(engine), onStep: (s) => steps.push(s) }, "/p/a.mp4");
    // Two codecs, three sampled windows each.
    expect(steps).toEqual([1, 2, 3, 4, 5, 6].map((done) => ({ done, total: 6 })));
  });

  it("is exact for a short clip and encodes it once", async () => {
    const { engine, calls } = fakeVideoEngine({ sampleBytes: () => 40_000 });
    const est = await estimateVideo(
      item({ durationSec: 3, outputs: [out("av1", { audio: "strip" })] }),
      deps(engine),
      "/p/a.mp4",
    );
    expect(calls.samples).toHaveLength(1);
    expect(calls.samples[0]).toMatchObject({ startSec: 0, durationSec: 3 });
    expect(est!.best).toMatchObject({ bytes: 40_000, basis: "exact" });
  });

  it("picks the smaller codec as the best", async () => {
    const { engine } = fakeVideoEngine({
      sampleBytes: (r) => (r.encoder === "libsvtav1" ? 5_000 : 20_000),
    });
    const est = await estimateVideo(item({ durationSec: 3 }), deps(engine), "/p/a.mp4");
    expect(est!.perCodec.map((c) => c.codec)).toEqual(["av1", "h264"]);
    expect(est!.best.codec).toBe("av1");
  });

  it("only estimates codecs that can actually be encoded here", async () => {
    const noAv1 = fakeVideoEngine({
      caps: { ...ALL_ENCODERS, libsvtav1: false, libaomAv1: false },
    });
    const est = await estimateVideo(item({ durationSec: 3 }), deps(noAv1.engine), "/p/a.mp4");
    expect(est!.perCodec.map((c) => c.codec)).toEqual(["h264"]);
    expect(noAv1.calls.samples.every((s) => s.encoder === "libx264")).toBe(true);

    const noEncoders = fakeVideoEngine({
      caps: { ...ALL_ENCODERS, libsvtav1: false, libaomAv1: false, libx264: false },
    });
    expect(await estimateVideo(item(), deps(noEncoders.engine), "/p/a.mp4")).toBeNull();
  });

  it("returns null with no ffmpeg or for skipped items, and never samples", async () => {
    const none = fakeVideoEngine({ caps: null });
    expect(await estimateVideo(item(), deps(none.engine), "/p/a.mp4")).toBeNull();
    const ok = fakeVideoEngine();
    expect(
      await estimateVideo(item({ skip: { reason: "x" } }), deps(ok.engine), "/p/a.mp4"),
    ).toBeNull();
    expect(ok.calls.samples).toEqual([]);
  });

  it("caches by content hash and parameters: a second estimate encodes nothing", async () => {
    const { engine, calls } = fakeVideoEngine();
    const cache = AnalysisCache.empty("t");
    const first = await estimateVideo(item(), deps(engine, cache), "/p/a.mp4");
    const after = calls.samples.length;
    expect(after).toBe(6); // 3 windows x 2 codecs
    const second = await estimateVideo(item(), deps(engine, cache), "/p/a.mp4");
    expect(calls.samples.length).toBe(after);
    expect(second).toEqual(first);
  });

  it("a parameter change or a different source invalidates the cached estimate", async () => {
    const { engine, calls } = fakeVideoEngine();
    const cache = AnalysisCache.empty("t");
    await estimateVideo(
      item({ durationSec: 3, outputs: [out("av1")] }),
      deps(engine, cache),
      "/p/a.mp4",
    );
    const base = calls.samples.length;
    await estimateVideo(
      item({ durationSec: 3, outputs: [out("av1", { crf: 40 })] }),
      deps(engine, cache),
      "/p/a.mp4",
    );
    expect(calls.samples.length).toBe(base + 1);
    await estimateVideo(
      item({ durationSec: 3, sourceSha256: "b".repeat(64), outputs: [out("av1")] }),
      deps(engine, cache),
      "/p/a.mp4",
    );
    expect(calls.samples.length).toBe(base + 2);
  });

  it("passes the preset's caps and sample window to the encoder", async () => {
    const { engine, calls } = fakeVideoEngine();
    await estimateVideo(
      item({
        durationSec: 100,
        outputs: [out("av1", { maxWidth: 1280, maxFps: 30, audio: "strip" })],
      }),
      deps(engine),
      "/p/a.mp4",
    );
    for (const s of calls.samples) {
      expect(s).toMatchObject({
        maxWidth: 1280,
        maxFps: 30,
        crf: 32,
        speed: "6",
        source: "/p/a.mp4",
      });
    }
  });
});

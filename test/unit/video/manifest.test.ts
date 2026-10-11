import { describe, expect, it } from "vitest";
import { checkVideoCache } from "../../../src/core/manifest/cache.js";
import type { ManifestVideoOutput, ManifestVideoSource } from "../../../src/core/manifest/types.js";
import type { PlannedVideoOutput, VideoPlanItem } from "../../../src/core/plan/types.js";

const H = "a".repeat(64);
const F = "b".repeat(64);

const av1: PlannedVideoOutput = {
  role: "video",
  path: "m/a/a-1280.av1.mp4",
  codec: "av1",
  width: 1280,
  crf: 32,
  speed: "6",
  maxWidth: null,
  maxFps: null,
  audio: "keep",
  audioBitrate: "128k",
};
const h264: PlannedVideoOutput = {
  ...av1,
  path: "m/a/a-1280.h264.mp4",
  codec: "h264",
  crf: 23,
  speed: "slow",
};

const item: VideoPlanItem = {
  source: "m/a.mp4",
  sourceBytes: 1000,
  sourceSha256: H,
  sourceWidth: 1280,
  sourceHeight: 720,
  durationSec: 3,
  fps: 30,
  hasAudio: true,
  videoCodec: "h264",
  preset: "content-video",
  outputs: [
    av1,
    h264,
    {
      role: "poster",
      path: "m/a/a-poster.avif",
      format: "avif",
      width: 1280,
      quality: 55,
      effort: 4,
      at: 0.1,
    },
  ],
};

const rec = (o: Partial<ManifestVideoOutput> & { path: string }): ManifestVideoOutput => ({
  url: `/_bytecut/${o.path}`,
  role: "video",
  format: "mp4",
  width: 1280,
  height: 720,
  bytes: 500,
  sha256: F,
  encoder: "libsvtav1 (ffmpeg 6)",
  status: "written",
  ...o,
});

const entry = (over: Partial<ManifestVideoSource> = {}): ManifestVideoSource => ({
  sha256: H,
  bytes: 1000,
  width: 1280,
  height: 720,
  durationSec: 3,
  preset: "content-video",
  outputs: [
    rec({
      path: av1.path,
      codec: "av1",
      crf: 32,
      speed: "6",
      maxWidth: null,
      maxFps: null,
      audio: "keep",
    }),
    rec({
      path: h264.path,
      codec: "h264",
      crf: 23,
      speed: "slow",
      maxWidth: null,
      maxFps: null,
      audio: "keep",
    }),
    rec({
      path: "m/a/a-poster.avif",
      role: "poster",
      format: "avif",
      quality: 55,
      effort: 4,
      at: 0.1,
    }),
  ],
  ...over,
});

const present = async () => F;

describe("checkVideoCache", () => {
  it("hits when everything matches", async () => {
    expect(await checkVideoCache(item, entry(), present)).toEqual({ kind: "hit" });
  });

  it("misses for a new source, a changed source, and a different preset", async () => {
    expect(await checkVideoCache(item, undefined, present)).toMatchObject({ reason: "new" });
    expect(await checkVideoCache(item, entry({ sha256: "c".repeat(64) }), present)).toMatchObject({
      reason: "source-changed",
    });
    expect(
      await checkVideoCache(item, entry({ preset: "background-video" }), present),
    ).toMatchObject({
      reason: "outputs-differ",
    });
  });

  it.each([
    ["crf", { ...av1, crf: 30 }],
    ["speed", { ...av1, speed: "8" }],
    ["audio", { ...av1, audio: "strip" as const }],
    ["maxWidth", { ...av1, maxWidth: 1920 }],
    ["maxFps", { ...av1, maxFps: 30 }],
    ["width", { ...av1, width: 640 }],
  ])("misses when the planned %s differs from what was made", async (_name, changed) => {
    const modified = { ...item, outputs: [changed, h264, item.outputs[2]!] };
    expect(await checkVideoCache(modified, entry(), present)).toMatchObject({
      reason: "outputs-differ",
    });
  });

  it("misses when a poster parameter differs", async () => {
    const poster = { ...item.outputs[2]!, quality: 40 };
    const modified = { ...item, outputs: [av1, h264, poster] };
    expect(await checkVideoCache(modified, entry(), present)).toMatchObject({
      reason: "outputs-differ",
    });
  });

  it("misses when a file is missing, modified, or stale", async () => {
    expect(await checkVideoCache(item, entry(), async () => null)).toMatchObject({
      reason: "output-missing",
    });
    expect(await checkVideoCache(item, entry(), async () => "d".repeat(64))).toMatchObject({
      reason: "output-modified",
    });
    const stale = entry();
    stale.outputs[0] = { ...stale.outputs[0]!, status: "stale" };
    expect(await checkVideoCache(item, stale, present)).toMatchObject({ reason: "output-stale" });
  });

  it("does not count outputs whose encoder is unavailable as misses", async () => {
    const withoutAv1 = entry({ outputs: entry().outputs.filter((o) => o.codec !== "av1") });
    expect(await checkVideoCache(item, withoutAv1, present)).toMatchObject({ kind: "miss" });
    expect(await checkVideoCache(item, withoutAv1, present, new Set(["av1"]))).toEqual({
      kind: "hit",
    });
  });

  it("does not require a file for an already-optimal output", async () => {
    const e = entry();
    const { sha256: _sha, ...noHash } = e.outputs[0]!;
    void _sha;
    e.outputs[0] = { ...noHash, status: "already-optimal" };
    const looked: string[] = [];
    const state = await checkVideoCache(item, e, async (p) => {
      looked.push(p);
      return F;
    });
    expect(state).toEqual({ kind: "hit" });
    expect(looked).not.toContain(av1.path);
  });
});

describe("checkVideoCache with a perceptual search", () => {
  const searched = (over: Partial<PlannedVideoOutput> = {}): VideoPlanItem => ({
    ...item,
    outputs: [{ ...av1, search: { metric: "vmaf", target: 90 }, ...over }, h264, item.outputs[2]!],
  });
  const withRecordedAv1 = (over: Partial<ManifestVideoOutput>): ManifestVideoSource => {
    const e = entry();
    e.outputs[0] = { ...e.outputs[0]!, ...over };
    return e;
  };

  it("is a hit whatever CRF the search landed on", async () => {
    const e = withRecordedAv1({
      crf: 41,
      search: { metric: "vmaf", target: 90 },
      score: 90.4,
      scorer: "libvmaf",
    });
    expect(await checkVideoCache(searched(), e, present)).toEqual({ kind: "hit" });
  });

  it("misses when the target or the metric changed", async () => {
    const e = withRecordedAv1({ crf: 41, search: { metric: "vmaf", target: 90 } });
    expect(
      await checkVideoCache(searched({ search: { metric: "vmaf", target: 95 } }), e, present),
    ).toMatchObject({ reason: "outputs-differ" });
    expect(
      await checkVideoCache(
        searched({ search: { metric: "ssimulacra2", target: 90 } }),
        e,
        present,
      ),
    ).toMatchObject({ reason: "outputs-differ" });
  });

  it("misses when a search was added to, or removed from, the plan", async () => {
    const e = withRecordedAv1({ crf: 41, search: { metric: "vmaf", target: 90 } });
    // Plan without a search against an output that was searched.
    expect(await checkVideoCache(item, e, present)).toMatchObject({ reason: "outputs-differ" });
    // Plan with a search against an output that was made at a fixed CRF.
    expect(await checkVideoCache(searched(), entry(), present)).toMatchObject({
      reason: "outputs-differ",
    });
  });

  it("an output without a search still depends on its CRF", async () => {
    const e = withRecordedAv1({ crf: 41 });
    expect(await checkVideoCache(item, e, present)).toMatchObject({ reason: "outputs-differ" });
  });
});

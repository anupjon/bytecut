import { describe, expect, it } from "vitest";
import {
  CLIP_SECONDS,
  CRF_RANGE,
  FRAMES_PER_CLIP,
  clipsFor,
  createVideoSearcher,
  findCrf,
  fitCrfToSize,
  scoreGeometry,
  stepWidth,
} from "../../../src/core/quality/video-search.js";
import type { QualityScorer, RgbImage } from "../../../src/core/quality/types.js";
import { fakeVideoEngine, greyFrames, probeOf } from "../../video-helpers.js";

/** Higher CRF, lower score; `cliff` makes the line steeper beyond it. */
const line = (slope: number) => (crf: number) => 100 - crf * slope;

describe("findCrf", () => {
  const range = { lo: 10, hi: 63 };

  it("finds the highest CRF that still meets the target", async () => {
    // score = 100 - 1.2*crf → crf 25 gives 70, crf 26 gives 68.8.
    const probed: number[] = [];
    const out = await findCrf({
      ...range,
      start: 32,
      target: 70,
      measure: async (crf) => {
        probed.push(crf);
        return line(1.2)(crf);
      },
    });
    expect(out).toMatchObject({ ok: true, crf: 25 });
    expect(out.ok && out.score).toBeCloseTo(70, 5);
    // The measure is called once per CRF and the search is logarithmic, not a scan.
    expect(new Set(probed).size).toBe(probed.length);
    expect(probed.length).toBeLessThanOrEqual(8);
  });

  it("searches upward when the starting point already passes", async () => {
    const out = await findCrf({
      ...range,
      start: 20,
      target: 70,
      measure: async (c) => line(0.5)(c),
    });
    // 100 - 0.5*crf >= 70 holds up to crf 60.
    expect(out).toMatchObject({ ok: true, crf: 60 });
  });

  it("stops at the top of the range when everything passes", async () => {
    const out = await findCrf({ ...range, start: 30, target: 10, measure: async () => 95 });
    expect(out).toMatchObject({ ok: true, crf: 63 });
  });

  it("reports the best score reached when even the lowest CRF misses", async () => {
    const out = await findCrf({
      ...range,
      start: 30,
      target: 99,
      measure: async (c) => 90 - c / 10,
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.bestScore).toBeCloseTo(89, 5);
  });

  it("never returns a CRF it did not measure as passing, even when scores are not monotonic", async () => {
    // A bump at crf 40: it passes although 35 does not. Whatever is returned must have passed.
    const scores = (crf: number) => (crf === 40 ? 80 : crf <= 30 ? 85 : 60);
    const out = await findCrf({ ...range, start: 32, target: 75, measure: async (c) => scores(c) });
    expect(out.ok).toBe(true);
    if (out.ok) expect(scores(out.crf)).toBeGreaterThanOrEqual(75);
  });

  it("clamps a starting CRF that is outside the range", async () => {
    const out = await findCrf({ ...range, start: 99, target: 50, measure: async (c) => 100 - c });
    expect(out).toMatchObject({ ok: true, crf: 50 });
  });
});

describe("clipsFor", () => {
  it("scores a short video whole", () => {
    expect(clipsFor(5)).toEqual({ clips: [{ startSec: 0, durationSec: 5 }], whole: true });
  });

  it("samples three clips of two seconds inside a long one", () => {
    const { clips, whole } = clipsFor(60);
    expect(whole).toBe(false);
    expect(clips).toHaveLength(3);
    for (const clip of clips) {
      expect(clip.durationSec).toBe(CLIP_SECONDS);
      expect(clip.startSec).toBeGreaterThanOrEqual(0);
      expect(clip.startSec + clip.durationSec).toBeLessThanOrEqual(60);
    }
    expect(clips[0]!.startSec).toBeLessThan(clips[1]!.startSec);
    expect(clips[1]!.startSec).toBeLessThan(clips[2]!.startSec);
  });

  it("keeps clips inside a video just over the whole-video limit", () => {
    const { clips } = clipsFor(7);
    for (const clip of clips) expect(clip.startSec + clip.durationSec).toBeLessThanOrEqual(7);
  });
});

describe("scoreGeometry", () => {
  it("scales to at most 512 wide with even sides and the output's aspect ratio", () => {
    expect(scoreGeometry({ width: 1920, height: 1080 }, null)).toEqual({ width: 512, height: 288 });
    const odd = scoreGeometry({ width: 1001, height: 563 }, null);
    expect(odd.width % 2).toBe(0);
    expect(odd.height % 2).toBe(0);
  });

  it("never scales up, and honours the width cap", () => {
    expect(scoreGeometry({ width: 320, height: 180 }, null)).toEqual({ width: 320, height: 180 });
    expect(scoreGeometry({ width: 4000, height: 2000 }, 400)).toEqual({ width: 400, height: 200 });
  });
});

/** Score = the first byte of the encoded frame: encodedFrames encodes the score in the frame. */
const byteScorer: QualityScorer = {
  kind: "wasm",
  label: "fake",
  async score(_ref, got) {
    return got.data[0]!;
  },
  async close() {},
};

const level = (value: number, width: number, height: number): RgbImage[] =>
  greyFrames(FRAMES_PER_CLIP, width, height, Math.max(0, Math.min(255, Math.round(value))));

function searcherFor(
  options: Parameters<typeof fakeVideoEngine>[0],
  extra: Partial<Parameters<typeof createVideoSearcher>[0]> = {},
) {
  const fake = fakeVideoEngine(options);
  const searcher = createVideoSearcher({
    engine: fake.engine,
    metric: "ssimulacra2",
    target: 70,
    scorer: byteScorer,
    source: "/p/a.mp4",
    probe: probeOf({ durationSec: 60, width: 1280, height: 720 }),
    codec: "av1",
    encoder: "libsvtav1",
    speed: "6",
    maxWidth: null,
    maxFps: null,
    startCrf: 32,
    ...extra,
  });
  return { ...fake, searcher };
}

describe("video searcher", () => {
  it("scores a CRF by its worst clip", async () => {
    // Clip at 50% is harder: 15 points lower. The target is met only where THAT clip meets it.
    const { searcher } = searcherFor({
      encodedFrames: (r) =>
        level(110 - r.crf - (r.startSec > 20 && r.startSec < 40 ? 15 : 0), r.width, r.height),
    });
    const out = await searcher.find();
    // 110 - crf - 15 >= 70 → crf <= 25.
    expect(out).toMatchObject({ ok: true, crf: 25 });
  });

  it("decodes each reference clip once however many CRFs are tried", async () => {
    const { searcher, calls } = searcherFor({
      encodedFrames: (r) => level(110 - r.crf, r.width, r.height),
    });
    await searcher.find();
    expect(calls.clipFrames).toHaveLength(3);
    expect(calls.encodedFrames.length).toBeGreaterThan(3);
    for (const f of calls.clipFrames) {
      expect(f.pipeline).not.toBeNull();
      expect(f.count).toBe(FRAMES_PER_CLIP);
    }
  });

  it("asks for frames at the same geometry on both sides", async () => {
    const { searcher, calls } = searcherFor({
      encodedFrames: (r) => level(110 - r.crf, r.width, r.height),
    });
    await searcher.find();
    const geometry = new Set([
      ...calls.clipFrames.map((f) => `${f.width}x${f.height}`),
      ...calls.encodedFrames.map((f) => `${f.width}x${f.height}`),
    ]);
    expect([...geometry]).toEqual(["512x288"]);
  });

  it("uses libvmaf's number as the clip score for the vmaf metric", async () => {
    const { searcher, calls } = searcherFor(
      { vmaf: (r) => 100 - r.crf * 0.5 },
      { metric: "vmaf", target: 85, scorer: undefined },
    );
    const out = await searcher.find();
    // 100 - 0.5*crf >= 85 → crf <= 30.
    expect(out).toMatchObject({ ok: true, crf: 30 });
    expect(calls.vmaf.length).toBeGreaterThan(0);
    expect(calls.encodedFrames).toHaveLength(0);
  });

  it("confirms an output over the same clips with the same metric", async () => {
    const { searcher, calls } = searcherFor({
      encodedFrames: (r) => level(110 - r.crf, r.width, r.height),
      frames: (r) => level(r.pipeline === null ? 66 : 0, r.width, r.height),
    });
    const score = await searcher.confirm("/out/a.mp4", 30);
    expect(score).toBe(66);
    const confirms = calls.clipFrames.filter((f) => f.source === "/out/a.mp4");
    expect(confirms).toHaveLength(3);
    expect(confirms.every((f) => f.pipeline === null)).toBe(true);
  });

  it("confirms by the worst clip too", async () => {
    const { searcher } = searcherFor({
      // The middle clip of the output is worse than its neighbours.
      frames: (r) =>
        level(
          r.pipeline !== null ? 0 : r.startSec > 20 && r.startSec < 40 ? 55 : 90,
          r.width,
          r.height,
        ),
    });
    expect(await searcher.confirm("/out/a.mp4", 30)).toBe(55);
  });

  it("rejects a frame count mismatch rather than scoring a partial clip", async () => {
    const { searcher } = searcherFor({
      encodedFrames: (r) => greyFrames(1, r.width, r.height),
    });
    await expect(searcher.find()).rejects.toThrow(/frames/);
  });

  it("covers both codecs' CRF ranges", () => {
    expect(CRF_RANGE.av1.hi).toBe(63);
    expect(CRF_RANGE.h264.hi).toBe(51);
  });
});

describe("fitting a size cap", () => {
  const sizes = (bytesAt: (crf: number) => number) => {
    const asked: number[] = [];
    return {
      asked,
      sizeAt: async (crf: number) => {
        asked.push(crf);
        return bytesAt(crf);
      },
    };
  };
  const linear = (crf: number) => (100 - crf) * 100;

  it("keeps the quality CRF when it already fits, measuring nothing else", async () => {
    const s = sizes(linear);
    const out = await fitCrfToSize({ lo: 40, hi: 63, maxBytes: 7000, sizeAt: s.sizeAt });
    expect(out).toEqual({ ok: true, crf: 40, bytes: 6000 });
    expect(s.asked).toEqual([40]);
  });

  it("finds the lowest CRF that fits, by bisection", async () => {
    const s = sizes(linear);
    const out = await fitCrfToSize({ lo: 40, hi: 63, maxBytes: 4000, sizeAt: s.sizeAt });
    expect(out).toEqual({ ok: true, crf: 60, bytes: 4000 });
    expect(s.asked.length).toBeLessThanOrEqual(8);
    // One CRF lower would not fit.
    expect(linear(59)).toBeGreaterThan(4000);
  });

  it("reports the best size reached when nothing fits", async () => {
    const out = await fitCrfToSize({
      lo: 40,
      hi: 51,
      maxBytes: 100,
      sizeAt: async (c) => linear(c),
    });
    expect(out).toEqual({ ok: false, crf: 51, bytes: 4900 });
  });
});

describe("stepping the width down", () => {
  it("narrows by a fifth, stays even and stops before half", () => {
    const widths = [1920];
    for (let next = stepWidth(1920, 1920); next !== null; next = stepWidth(1920, next)) {
      widths.push(next);
    }
    expect(widths).toEqual([1920, 1536, 1228, 982]);
    expect(widths.every((w) => w % 2 === 0)).toBe(true);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(960);
  });

  it("has nowhere to go for a tiny video", () => {
    expect(stepWidth(2, 2)).toBeNull();
  });
});

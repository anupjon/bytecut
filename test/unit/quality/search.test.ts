import { describe, expect, it } from "vitest";
import type { EncodeResult, ImageEngine, RawImage } from "../../../src/core/engines/types.js";
import { searchQuality, type SearchRequest } from "../../../src/core/quality/search.js";
import type { QualityScorer, RgbImage } from "../../../src/core/quality/types.js";

/**
 * A model of an encoder: quality q scores `30 + 0.7 q` (100 at q = 100), a full-size encode
 * is `(w / 1000)^2 * 400 * q` bytes, and a crop is `10 q` bytes. Encoded buffers carry their
 * quality and size in a header so decoding can recover them.
 */
interface Model {
  sourceWidth: number;
  /** Subtracted from full-size scores: the sample is optimistic about the whole image. */
  fullPenalty: number;
  transparent: boolean;
  /** Qualities whose full-size score is replaced: real encoders are not perfectly monotonic. */
  dip?: { from: number; to: number; score: number };
  encodes: Array<{ kind: "crop" | "full"; quality: number; width: number }>;
  scores: number;
}

function model(over: Partial<Model> = {}): Model {
  return { sourceWidth: 2000, fullPenalty: 0, transparent: false, encodes: [], scores: 0, ...over };
}

function header(quality: number, width: number, height: number, size: number): Buffer {
  const b = Buffer.alloc(Math.max(size, 8));
  b[0] = 0xee;
  b[1] = quality;
  b.writeUInt16LE(width, 2);
  b.writeUInt16LE(height, 4);
  return b;
}

function fakeEngine(m: Model, withRaw = true): ImageEngine {
  const engine: Partial<ImageEngine> = {
    async encode(_input, request): Promise<EncodeResult> {
      const width = Math.min(request.width, m.sourceWidth);
      const height = Math.round(width * 0.75);
      m.encodes.push({ kind: "full", quality: request.quality, width });
      const bytes = Math.round((width / 1000) ** 2 * 400 * request.quality);
      return {
        data: header(request.quality, width, height, bytes),
        width,
        height,
        encoder: "fake",
      };
    },
  };
  if (withRaw) {
    engine.decodeRaw = async (input, options): Promise<RawImage> => {
      if (input[0] === 0xee) {
        const width = input.readUInt16LE(2);
        const height = input.readUInt16LE(4);
        const data = new Uint8Array(width * height * 4).fill(255);
        data[0] = input[1]!;
        return { data, width, height, channels: 4 };
      }
      const width = Math.min(options.width ?? m.sourceWidth, m.sourceWidth);
      const height = Math.round(width * 0.75);
      const data = new Uint8Array(width * height * 4).fill(255);
      if (m.transparent) data[7] = 0; // one fully transparent pixel
      return { data, width, height, channels: 4 };
    };
    engine.encodeRaw = async (image, request): Promise<EncodeResult> => {
      m.encodes.push({ kind: "crop", quality: request.quality, width: image.width });
      return {
        data: header(request.quality, image.width, image.height, request.quality * 10),
        width: image.width,
        height: image.height,
        encoder: "fake",
      };
    };
  }
  return engine as ImageEngine;
}

function fakeScorer(m: Model): QualityScorer {
  return {
    kind: "wasm",
    label: "fake",
    async score(_reference: RgbImage, distorted: RgbImage) {
      m.scores++;
      const quality = distorted.data[0]!;
      const full = distorted.width > 512;
      if (full && m.dip && quality >= m.dip.from && quality <= m.dip.to) return m.dip.score;
      return 30 + 0.7 * quality - (full ? m.fullPenalty : 0);
    },
    async close() {},
  };
}

function request(
  m: Model,
  search: SearchRequest["search"],
  over: Partial<SearchRequest> = {},
): SearchRequest {
  return {
    engine: fakeEngine(m),
    scorer: fakeScorer(m),
    input: Buffer.from("source"),
    format: "avif",
    width: 1280,
    effort: 4,
    search,
    minWidth: 0,
    ...over,
  };
}

const fulls = (m: Model) => m.encodes.filter((e) => e.kind === "full");

describe("searchQuality", () => {
  it("finds the smallest quality that reaches the target, with one full-size encode", async () => {
    const m = model();
    const out = await searchQuality(request(m, { metric: "ssimulacra2", target: 79 }));
    expect(out).toMatchObject({ ok: true, quality: 70, width: 1280 });
    // 30 + 0.7 * 69 = 78.3 < 79 <= 79.0 = 30 + 0.7 * 70.
    expect(fulls(m)).toHaveLength(1);
    // A binary search over 1..100 plus the check at 100: at most 8 sampled encodes.
    expect(m.encodes.filter((e) => e.kind === "crop").length).toBeLessThanOrEqual(8);
    if (out.ok) expect(out.score).toBeCloseTo(79, 5);
  });

  it("asks for less when the target is lower, and for more when it is higher", async () => {
    const quality = async (target: number) => {
      const out = await searchQuality(request(model(), { metric: "ssimulacra2", target }));
      return out.ok ? out.quality : -1;
    };
    const [low, mid, high] = [await quality(60), await quality(80), await quality(95)];
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it("proves the answer on the whole image and raises quality when the sample was optimistic", async () => {
    const m = model({ fullPenalty: 1 });
    const out = await searchQuality(request(m, { metric: "ssimulacra2", target: 79 }));
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.quality).toBeGreaterThan(70);
    expect(out.score).toBeGreaterThanOrEqual(79);
    expect(out.notes.join("\n")).toMatch(
      /quality 70 scored 78\.00 at full size \(target 79\); raised to 71/,
    );
  });

  it("fails, rather than returning a worse file, when the target cannot be reached", async () => {
    const m = model({ fullPenalty: 20 });
    const out = await searchQuality(request(m, { metric: "ssimulacra2", target: 95 }));
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.reason).toMatch(/below the target 95/);
  });

  describe("maxSize", () => {
    it("lowers quality only as far as needed to fit", async () => {
      const m = model();
      const out = await searchQuality(
        request(m, { metric: "ssimulacra2", target: 79, floor: 60, maxBytes: 30_000 }),
      );
      expect(out).toMatchObject({ ok: true, width: 1280, quality: 45 });
      if (!out.ok) return;
      expect(out.encoded.data.byteLength).toBeLessThanOrEqual(30_000);
      expect(out.score).toBeGreaterThanOrEqual(60);
      // 46 would be 30146 bytes: the largest quality that fits is 45.
      expect(out.notes.join("\n")).toMatch(/lowered to 45/);
    });

    it("steps the width down, by the actual width, when even the floor is too big", async () => {
      const m = model();
      const out = await searchQuality(
        request(m, { metric: "ssimulacra2", target: 79, floor: 60, maxBytes: 10_000 }),
      );
      expect(out).toMatchObject({ ok: true });
      if (!out.ok) return;
      expect(out.width).toBeLessThan(1280);
      expect(out.width % 2).toBe(0);
      expect(out.encoded.width).toBe(out.width);
      expect(out.encoded.data.byteLength).toBeLessThanOrEqual(10_000);
      expect(out.notes[0]).toMatch(
        new RegExp(
          `^stepped the width down from 1280px to ${out.width}px to fit \\(\\d+ wider sizes? did not\\)$`,
        ),
      );
    });

    it("stops at the next smaller planned width instead of duplicating it", async () => {
      const m = model();
      const out = await searchQuality(
        request(
          m,
          { metric: "ssimulacra2", target: 79, floor: 60, maxBytes: 10_000 },
          { minWidth: 800 },
        ),
      );
      expect(out).toMatchObject({ ok: false });
      if (!out.ok) {
        expect(out.reason).toMatch(/over the 9\.8 KB cap/);
        expect(out.reason).toMatch(/next planned width \(800px\)/);
      }
    });

    it("never steps below half the planned width, even with no smaller sibling", async () => {
      const out = await searchQuality(
        request(model(), { metric: "ssimulacra2", target: 79, floor: 60, maxBytes: 1_000 }),
      );
      expect(out).toMatchObject({ ok: false });
      if (!out.ok) expect(out.reason).toMatch(/half the planned width \(640px\)/);
    });

    it("does not take a quality that fits the cap but dips below the floor at full size", async () => {
      // Qualities 44-45 fit 30 KB but score 50 on the whole image; 43 is the right answer.
      const m = model({ dip: { from: 44, to: 45, score: 50 } });
      const out = await searchQuality(
        request(m, { metric: "ssimulacra2", target: 79, floor: 60, maxBytes: 30_000 }),
      );
      expect(out).toMatchObject({ ok: true, quality: 43 });
      if (out.ok) expect(out.score).toBeGreaterThanOrEqual(60);
    });

    it("never produces a file over the cap or below the floor", async () => {
      for (const maxBytes of [8_000, 15_000, 25_000, 40_000]) {
        const out = await searchQuality(
          request(model(), { metric: "ssimulacra2", target: 90, floor: 55, maxBytes }),
        );
        if (out.ok) {
          expect(out.encoded.data.byteLength).toBeLessThanOrEqual(maxBytes);
          expect(out.score).toBeGreaterThanOrEqual(55);
        }
      }
    });
  });

  it("scores over white and over black when the image has transparency, and keeps the worse", async () => {
    const opaque = model();
    await searchQuality(request(opaque, { metric: "ssimulacra2", target: 79 }));
    const alpha = model({ transparent: true });
    await searchQuality(request(alpha, { metric: "ssimulacra2", target: 79 }));
    expect(alpha.scores).toBe(opaque.scores * 2);
  });

  it("is deterministic: the same inputs always give the same answer", async () => {
    const run = async () => {
      const out = await searchQuality(
        request(model({ fullPenalty: 0.5 }), {
          metric: "ssimulacra2",
          target: 82,
          floor: 60,
          maxBytes: 30_000,
        }),
      );
      return out.ok ? [out.quality, out.width, out.score, out.encodes] : out.reason;
    };
    expect(await run()).toEqual(await run());
  });

  it("reports an engine that cannot decode raw pixels as unsearchable, not as a failure", async () => {
    const m = model();
    const out = await searchQuality({
      ...request(m, { metric: "ssimulacra2", target: 80 }),
      engine: fakeEngine(m, false),
    });
    expect(out).toMatchObject({ ok: false, unsearchable: true });
  });

  it("reports an image too small to score as unsearchable", async () => {
    const m = model({ sourceWidth: 6 });
    const out = await searchQuality(
      request(m, { metric: "ssimulacra2", target: 80 }, { width: 6 }),
    );
    expect(out).toMatchObject({ ok: false, unsearchable: true });
  });

  it("stops promptly when cancelled and writes nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await searchQuality(
      request(model(), { metric: "ssimulacra2", target: 80 }, { signal: controller.signal }),
    );
    expect(out).toMatchObject({ ok: false, cancelled: true });
  });
});

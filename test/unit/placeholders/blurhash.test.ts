import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  componentsFor,
  decodeBlurhash,
  encodeBlurhash,
} from "../../../src/core/placeholders/blurhash.js";
import { vectorPixels } from "../../helpers.js";

interface Vector {
  seed: number;
  width: number;
  height: number;
  componentX: number;
  componentY: number;
  /** The reference algorithm with the largest ABSOLUTE AC value, as the spec text says. */
  hash: string;
  /** What the published `blurhash@2.0.5` package returns (signed maximum). */
  npmHash: string;
  decoded8x6: string;
}

/**
 * Recorded with the reference `blurhash` 2.0.5 package. `hash` comes from a copy of that
 * package with one expression changed (signed maximum → absolute maximum), `npmHash` from the
 * unmodified package. They differ only when the largest-magnitude AC value is negative.
 */
interface GradientVector extends Omit<Vector, "seed"> {
  gradient: "right" | "left" | "down";
}

const recorded: { vectors: Vector[]; gradients: GradientVector[] } = JSON.parse(
  readFileSync(new URL("../../fixtures/blurhash-reference.json", import.meta.url), "utf8"),
);
const vectors = recorded.vectors;
const gradients = recorded.gradients;

// Same formula as the script that recorded the vectors.
function gradientPixels(dir: GradientVector["gradient"], w: number, h: number) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = dir === "right" ? x / (w - 1) : dir === "left" ? 1 - x / (w - 1) : y / (h - 1);
      px[i] = Math.round(t * 255);
      px[i + 1] = Math.round(t * 120 + 40);
      px[i + 2] = 90;
      px[i + 3] = 255;
    }
  }
  return px;
}

const meanError = (hash: string, px: Uint8ClampedArray, w: number, h: number) => {
  const back = decodeBlurhash(hash, w, h);
  let e = 0;
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c++) e += Math.abs(px[i + c]! - back[i + c]!);
  }
  return e / (w * h * 3);
};

describe("BlurHash encoder matches the reference implementation", () => {
  it("has a meaningful set of vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(8);
    // Includes the extremes: a single pixel, one component, and the maximum 9x9.
    expect(vectors.some((v) => v.width === 1 && v.height === 1)).toBe(true);
    expect(vectors.some((v) => v.componentX === 1 && v.componentY === 1)).toBe(true);
    expect(vectors.some((v) => v.componentX === 9 && v.componentY === 9)).toBe(true);
  });

  it.each(vectors)(
    "seed $seed ($width x $height, $componentX x $componentY) encodes to the reference hash",
    (v) => {
      const hash = encodeBlurhash(
        vectorPixels(v.seed, v.width, v.height),
        v.width,
        v.height,
        v.componentX,
        v.componentY,
      );
      expect(hash).toBe(v.hash);
    },
  );

  it("equals the unmodified npm package everywhere except the documented deviation", () => {
    const differing = vectors.filter((v) => v.hash !== v.npmHash);
    // Pinned so the deviation cannot widen unnoticed: 4 of the 9 recorded vectors.
    expect(differing.map((v) => v.seed)).toEqual([1, 2, 3, 8]);
    for (const v of vectors.filter((x) => x.hash === x.npmHash)) {
      const ours = encodeBlurhash(
        vectorPixels(v.seed, v.width, v.height),
        v.width,
        v.height,
        v.componentX,
        v.componentY,
      );
      expect(ours).toBe(v.npmHash);
    }
  });

  it("on pseudo-random noise the deviation is a wash (measured: within 6% either way)", () => {
    for (const v of vectors.filter((x) => x.hash !== x.npmHash)) {
      const px = vectorPixels(v.seed, v.width, v.height);
      const ours = meanError(v.hash, px, v.width, v.height);
      const theirs = meanError(v.npmHash, px, v.width, v.height);
      expect(Math.abs(ours - theirs) / theirs, `seed ${v.seed}`).toBeLessThan(0.1);
    }
  });

  describe("gradients, where the deviation matters", () => {
    it.each(gradients)("$gradient matches the corrected reference", (g) => {
      const hash = encodeBlurhash(
        gradientPixels(g.gradient, g.width, g.height),
        g.width,
        g.height,
        g.componentX,
        g.componentY,
      );
      expect(hash).toBe(g.hash);
    });

    it("a dark-to-light gradient is approximated several times better than with the npm package", () => {
      for (const g of gradients.filter((x) => x.hash !== x.npmHash)) {
        const px = gradientPixels(g.gradient, g.width, g.height);
        const ours = meanError(g.hash, px, g.width, g.height);
        const theirs = meanError(g.npmHash, px, g.width, g.height);
        expect(ours * 2, g.gradient).toBeLessThan(theirs);
      }
      // Guard against a vacuous pass: at least two of the three gradients must differ.
      expect(gradients.filter((x) => x.hash !== x.npmHash).length).toBeGreaterThanOrEqual(2);
    });

    it("a light-to-dark gradient is unaffected", () => {
      const g = gradients.find((x) => x.gradient === "left")!;
      expect(g.hash).toBe(g.npmHash);
    });
  });

  it.each(vectors)("seed $seed decodes to the same pixels as the reference decoder", (v) => {
    const ours = decodeBlurhash(v.hash, 8, 6);
    const reference = new Uint8ClampedArray(Buffer.from(v.decoded8x6, "base64"));
    expect(Array.from(ours)).toEqual(Array.from(reference));
  });
});

describe("BlurHash behaviour", () => {
  it("round-trips a smooth image to something close to the original", () => {
    const w = 32;
    const h = 20;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        px[i] = Math.round((x / (w - 1)) * 255);
        px[i + 1] = Math.round((y / (h - 1)) * 255);
        px[i + 2] = 128;
        px[i + 3] = 255;
      }
    }
    const hash = encodeBlurhash(px, w, h, 4, 3);
    const back = decodeBlurhash(hash, w, h);
    let error = 0;
    for (let i = 0; i < px.length; i += 4) {
      for (let c = 0; c < 3; c++) error += Math.abs(px[i + c]! - back[i + c]!);
    }
    // Mean absolute error per channel sample: low for a smooth gradient.
    expect(error / (w * h * 3)).toBeLessThan(12);
  });

  it("is deterministic, and its length follows the component count", () => {
    const px = vectorPixels(1, 16, 16);
    const a = encodeBlurhash(px, 16, 16, 4, 3);
    expect(encodeBlurhash(px, 16, 16, 4, 3)).toBe(a);
    // 1 (size) + 1 (max) + 4 (dc) + 2 per AC component.
    expect(a).toHaveLength(6 + 2 * (4 * 3 - 1));
  });

  it("a flat colour has a single-component hash that decodes back to that colour", () => {
    const px = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < px.length; i += 4) px.set([200, 100, 50, 255], i);
    const hash = encodeBlurhash(px, 4, 4, 1, 1);
    expect(hash).toHaveLength(6);
    const [r, g, b] = decodeBlurhash(hash, 1, 1);
    expect(Math.abs(r! - 200)).toBeLessThanOrEqual(2);
    expect(Math.abs(g! - 100)).toBeLessThanOrEqual(2);
    expect(Math.abs(b! - 50)).toBeLessThanOrEqual(2);
  });

  it("rejects out-of-range components and mismatched buffers", () => {
    const px = vectorPixels(1, 4, 4);
    expect(() => encodeBlurhash(px, 4, 4, 0, 3)).toThrow(RangeError);
    expect(() => encodeBlurhash(px, 4, 4, 10, 3)).toThrow(RangeError);
    expect(() => encodeBlurhash(px, 5, 4, 3, 3)).toThrow(/does not match/);
  });

  it("ignores alpha", () => {
    const a = vectorPixels(2, 8, 8);
    const b = new Uint8ClampedArray(a);
    for (let i = 3; i < b.length; i += 4) b[i] = 0;
    expect(encodeBlurhash(b, 8, 8, 4, 3)).toBe(encodeBlurhash(a, 8, 8, 4, 3));
  });

  it("picks more components along the longer axis", () => {
    expect(componentsFor(1600, 900)).toEqual([4, 3]);
    expect(componentsFor(900, 1600)).toEqual([3, 4]);
    expect(componentsFor(500, 500)).toEqual([4, 4]);
    expect(componentsFor(0, 0)).toEqual([4, 3]);
  });
});

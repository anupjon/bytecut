import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, loadScorer, MIN_SIDE } from "@bytecut/ssimulacra2";

const dir = join(import.meta.dirname, "../../fixtures/ssimulacra2");
const golden = JSON.parse(await readFile(join(dir, "reference-scores.json"), "utf8")) as {
  toolCommit: string;
  pairs: Array<{ reference: string; distorted: string; score: number }>;
};

/**
 * The largest difference seen against the C++ reference on these pairs was 0.032 on a
 * 0..100 scale. The tolerance leaves 3x headroom for libm differences across platforms and
 * is still far below anything that would move a quality search (it steps in whole points).
 */
const TOLERANCE = 0.1;

async function rgb(file: string) {
  const { data, info } = await sharp(join(dir, file))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

let scorer: Awaited<ReturnType<typeof loadScorer>>;
beforeAll(async () => {
  scorer = await loadScorer();
});

describe("WASM SSIMULACRA2 against the reference C++ tool", () => {
  it("has recorded scores for every fixture pair", () => {
    expect(golden.pairs).toHaveLength(16);
    expect(golden.toolCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each(golden.pairs.map((p) => [p.distorted, p] as const))(
    "%s agrees with the reference within %f",
    async (_name, pair) => {
      const actual = scorer.score(await rgb(pair.reference), await rgb(pair.distorted));
      expect(Math.abs(actual - pair.score)).toBeLessThan(TOLERANCE);
    },
  );

  it("scores an image against itself as exactly 100", async () => {
    const image = await rgb("photo-ref.png");
    expect(scorer.score(image, image)).toBe(100);
  });

  it("orders quality the way the eye does: lower JPEG quality scores lower", async () => {
    for (const set of ["photo", "synthetic"]) {
      const ref = await rgb(`${set}-ref.png`);
      const [q20, q50, q85] = await Promise.all(
        ["jpeg-q20", "jpeg-q50", "jpeg-q85"].map(async (k) =>
          scorer.score(ref, await rgb(`${set}-${k}.png`)),
        ),
      );
      expect(q20!).toBeLessThan(q50!);
      expect(q50!).toBeLessThan(q85!);
    }
  });

  it("is deterministic", async () => {
    const [ref, dist] = [await rgb("photo-ref.png"), await rgb("photo-jpeg-q50.png")];
    expect(scorer.score(ref, dist)).toBe(scorer.score(ref, dist));
  });

  it("refuses inputs it cannot score instead of returning a number", async () => {
    const ok = await rgb("photo-ref.png");
    const small = { data: new Uint8Array(4 * 4 * 3), width: 4, height: 4 };
    expect(() => scorer.score(small, small)).toThrow(
      new RegExp(`at least ${MIN_SIDE}x${MIN_SIDE}`),
    );
    const other = { data: new Uint8Array(16 * 16 * 3), width: 16, height: 16 };
    expect(() => scorer.score(ok, other)).toThrow(/images differ in size/);
    expect(() => scorer.score({ ...ok, data: ok.data.subarray(1) }, ok)).toThrow(
      /expected \d+ bytes/,
    );
    expect(() => scorer.score({ ...ok, width: 0 }, ok)).toThrow(/positive integers/);
    // @ts-expect-error not an image
    expect(() => scorer.score(null, ok)).toThrow(TypeError);
  });

  it("does not leak: thousands of scores in one instance stay usable", async () => {
    const [ref, dist] = [await rgb("synthetic-ref.png"), await rgb("synthetic-blur.png")];
    const first = scorer.score(ref, dist);
    for (let i = 0; i < 40; i++) scorer.score(ref, dist);
    expect(scorer.score(ref, dist)).toBe(first);
  });
});

describe("worker pool", () => {
  const pool = createPool({ size: 2 });
  afterAll(() => pool.close());

  it("returns the same scores as the in-thread scorer, concurrently", async () => {
    const [ref, a, b] = [
      await rgb("photo-ref.png"),
      await rgb("photo-jpeg-q20.png"),
      await rgb("photo-noise.png"),
    ];
    const results = await Promise.all([pool.score(ref, a), pool.score(ref, b), pool.score(ref, a)]);
    expect(results).toEqual([scorer.score(ref, a), scorer.score(ref, b), scorer.score(ref, a)]);
  });

  it("reports a bad input as a rejection, and keeps working", async () => {
    const ok = await rgb("photo-ref.png");
    await expect(pool.score({ ...ok, width: 1 }, ok)).rejects.toThrow(/expected \d+ bytes/);
    await expect(pool.score(ok, ok)).resolves.toBe(100);
  });

  it("rejects after close", async () => {
    const closed = createPool({ size: 1 });
    await closed.close();
    const ok = await rgb("photo-ref.png");
    await expect(closed.score(ok, ok)).rejects.toThrow(/closed/);
  });
});

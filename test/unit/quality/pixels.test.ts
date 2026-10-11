import { describe, expect, it } from "vitest";
import type { RawImage } from "../../../src/core/engines/types.js";
import {
  crop,
  dropAlpha,
  flatten,
  hasTransparency,
  pickWindow,
} from "../../../src/core/quality/pixels.js";

const rgba = (
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number],
): RawImage => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(fill(x, y), (y * width + x) * 4);
  }
  return { data, width, height, channels: 4 };
};

describe("transparency", () => {
  it("is only true when a pixel is actually not opaque", () => {
    expect(hasTransparency(rgba(4, 4, () => [1, 2, 3, 255]))).toBe(false);
    expect(hasTransparency(rgba(4, 4, (x) => [1, 2, 3, x === 2 ? 254 : 255]))).toBe(true);
    expect(hasTransparency({ data: new Uint8Array(12), width: 2, height: 2, channels: 3 })).toBe(
      false,
    );
  });

  it("flattens over white and over black, and drops alpha", () => {
    const image = rgba(2, 1, (x) => (x === 0 ? [200, 100, 0, 255] : [200, 100, 0, 0]));
    expect([...flatten(image, "white").data]).toEqual([200, 100, 0, 255, 255, 255]);
    expect([...flatten(image, "black").data]).toEqual([200, 100, 0, 0, 0, 0]);
    const half = rgba(1, 1, () => [100, 100, 100, 128]);
    expect([...flatten(half, "white").data]).toEqual([177, 177, 177]);
    expect([...flatten(half, "black").data]).toEqual([50, 50, 50]);
    expect([...dropAlpha(image).data]).toEqual([200, 100, 0, 200, 100, 0]);
  });
});

describe("pickWindow / crop", () => {
  /** Left third flat, middle third mild, right third noisy. */
  const banded = rgba(96, 32, (x, y) => {
    if (x < 32) return [100, 100, 100, 255];
    if (x < 64) return [100 + ((x + y) % 2) * 6, 100, 100, 255];
    const v = (x * 37 + y * 91) % 255;
    return [v, v, v, 255];
  });

  it("takes the whole image when it is smaller than the window", () => {
    expect(pickWindow(banded, 512)).toEqual({ x: 0, y: 0, width: 96, height: 32 });
  });

  it("picks the tile of median detail, not the flattest or the busiest", () => {
    const window = pickWindow(banded, 32);
    expect(window).toEqual({ x: 32, y: 0, width: 32, height: 32 });
  });

  it("is deterministic and breaks ties by position", () => {
    const flat = rgba(64, 64, () => [9, 9, 9, 255]);
    expect(pickWindow(flat, 32)).toEqual(pickWindow(flat, 32));
    expect(pickWindow(flat, 32)).toEqual({ x: 32, y: 0, width: 32, height: 32 });
  });

  it("crops exactly the requested pixels", () => {
    const image = rgba(8, 8, (x, y) => [x, y, 0, 255]);
    const piece = crop(image, { x: 2, y: 3, width: 3, height: 2 });
    expect(piece).toMatchObject({ width: 3, height: 2, channels: 4 });
    expect([...piece.data.slice(0, 4)]).toEqual([2, 3, 0, 255]);
    expect([...piece.data.slice(-4)]).toEqual([4, 4, 0, 255]);
  });
});

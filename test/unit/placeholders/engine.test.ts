import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { sharpImageEngine } from "../../../src/core/engines/image.js";
import { decodeBlurhash } from "../../../src/core/placeholders/blurhash.js";
import { isPlaceholderKind } from "../../../src/core/placeholders/types.js";

const solid = (r: number, g: number, b: number, w = 120, h = 80) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 95 })
    .toBuffer();

describe("sharp placeholder engine", () => {
  const make = (
    input: Buffer,
    kind: Parameters<NonNullable<typeof sharpImageEngine.placeholder>>[1],
  ) => sharpImageEngine.placeholder!(input, kind);

  it("dominant colour is a #rrggbb string close to a flat image's colour", async () => {
    const p = await make(await solid(200, 40, 40), "dominant-color");
    expect(p.kind).toBe("dominant-color");
    expect(p.value).toMatch(/^#[0-9a-f]{6}$/);
    const n = parseInt(p.value.slice(1), 16);
    expect(Math.abs((n >> 16) - 200)).toBeLessThan(16);
    expect(Math.abs(((n >> 8) & 255) - 40)).toBeLessThan(16);
    expect(Math.abs((n & 255) - 40)).toBeLessThan(16);
  });

  it("lqip is a small WebP data URI that really decodes, at most 16px on the long edge", async () => {
    const p = await make(await solid(30, 90, 200, 400, 200), "lqip");
    expect(p.value.startsWith("data:image/webp;base64,")).toBe(true);
    expect(p.value.length).toBeLessThan(400);
    const bytes = Buffer.from(p.value.split(",")[1]!, "base64");
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(16);
    expect(meta.width! / meta.height!).toBeCloseTo(2, 0);
  });

  it("blurhash decodes back to roughly the source colour", async () => {
    const p = await make(await solid(20, 160, 60), "blurhash");
    const [r, g, b] = decodeBlurhash(p.value, 1, 1);
    expect(Math.abs(r! - 20)).toBeLessThan(20);
    expect(Math.abs(g! - 160)).toBeLessThan(20);
    expect(Math.abs(b! - 60)).toBeLessThan(20);
  });

  it("applies EXIF orientation before sampling (a portrait stays portrait)", async () => {
    const jpeg = await sharp({
      create: { width: 160, height: 80, channels: 3, background: "#888" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const p = await make(jpeg, "lqip");
    const meta = await sharp(Buffer.from(p.value.split(",")[1]!, "base64")).metadata();
    expect(meta.height!).toBeGreaterThan(meta.width!);
  });

  it("is deterministic for the same input", async () => {
    const input = await solid(10, 20, 30);
    for (const kind of ["dominant-color", "lqip", "blurhash"] as const) {
      expect((await make(input, kind)).value).toBe((await make(input, kind)).value);
    }
  });

  it("knows its kinds", () => {
    expect(isPlaceholderKind("lqip")).toBe(true);
    expect(isPlaceholderKind("blur")).toBe(false);
  });
});

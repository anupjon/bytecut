import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { hasGpsIfd } from "../../../src/core/engines/exif.js";

async function jpegWith(exif: Parameters<ReturnType<typeof sharp>["withExif"]>[0]) {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
    .jpeg()
    .withExif(exif)
    .toBuffer();
}

async function exifOf(buffer: Buffer) {
  const meta = await sharp(buffer).metadata();
  return meta.exif!;
}

describe("hasGpsIfd", () => {
  it("is true when the EXIF has GPS data", async () => {
    const jpeg = await jpegWith({
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "51/1 30/1 0/1",
        GPSLongitudeRef: "W",
        GPSLongitude: "0/1 7/1 0/1",
      },
    });
    expect(hasGpsIfd(await exifOf(jpeg))).toBe(true);
  });

  it("is false for EXIF without GPS", async () => {
    const jpeg = await jpegWith({ IFD0: { Make: "camera" } });
    expect(hasGpsIfd(await exifOf(jpeg))).toBe(false);
  });

  it("never throws on truncated or hostile buffers", () => {
    const valid = Buffer.from("Exif\0\0MM\0*\0\0\0\x08\xff\xff", "latin1");
    const cases = [
      Buffer.alloc(0),
      Buffer.from("Exif\0\0"),
      Buffer.from("Exif\0\0II*\0"),
      Buffer.from("garbage that is long enough to pass a length check"),
      valid,
      // IFD0 offset pointing far beyond the buffer.
      Buffer.from("Exif\0\0II*\0\xff\xff\xff\x7f", "latin1"),
    ];
    for (const buffer of cases) expect(() => hasGpsIfd(buffer)).not.toThrow();
    expect(cases.map(hasGpsIfd).every((v) => v === false)).toBe(true);
  });
});

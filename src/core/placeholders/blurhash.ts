/**
 * BlurHash encoder/decoder (https://blurha.sh, MIT). Implemented here rather than depended on
 * (an optional feature is not worth a runtime dependency). Tests assert byte-for-byte
 * agreement with the reference implementation on recorded vectors, with one documented
 * deviation: see the comment on `actualMax`.
 *
 * Input is RGBA, 8 bits per channel; alpha is ignored.
 */

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

function encode83(value: number, length: number): string {
  let out = "";
  for (let i = 1; i <= length; i++) {
    const digit = Math.floor(value / 83 ** (length - i)) % 83;
    out += ALPHABET[digit];
  }
  return out;
}

function decode83(text: string): number {
  let value = 0;
  for (const ch of text) value = value * 83 + ALPHABET.indexOf(ch);
  return value;
}

function sRGBToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSRGB(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308
    ? Math.trunc(v * 12.92 * 255 + 0.5)
    : Math.trunc((1.055 * v ** (1 / 2.4) - 0.055) * 255 + 0.5);
}

const signPow = (value: number, exp: number) => Math.sign(value) * Math.abs(value) ** exp;

type Factor = [number, number, number];

function basisFactor(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  xc: number,
  yc: number,
): Factor {
  let r = 0;
  let g = 0;
  let b = 0;
  const normalisation = xc === 0 && yc === 0 ? 1 : 2;
  const bytesPerRow = width * 4;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const basis =
        normalisation *
        Math.cos((Math.PI * xc * x) / width) *
        Math.cos((Math.PI * yc * y) / height);
      r += basis * sRGBToLinear(pixels[4 * x + y * bytesPerRow]!);
      g += basis * sRGBToLinear(pixels[4 * x + 1 + y * bytesPerRow]!);
      b += basis * sRGBToLinear(pixels[4 * x + 2 + y * bytesPerRow]!);
    }
  }
  const scale = 1 / (width * height);
  return [r * scale, g * scale, b * scale];
}

export function encodeBlurhash(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  componentX: number,
  componentY: number,
): string {
  if (componentX < 1 || componentX > 9 || componentY < 1 || componentY > 9) {
    throw new RangeError("BlurHash needs 1 to 9 components per axis");
  }
  if (pixels.length !== width * height * 4) {
    throw new RangeError("Pixel buffer does not match the given width and height");
  }

  const factors: Factor[] = [];
  for (let y = 0; y < componentY; y++) {
    for (let x = 0; x < componentX; x++) {
      factors.push(basisFactor(pixels, width, height, x, y));
    }
  }
  const dc = factors[0]!;
  const ac = factors.slice(1);

  let hash = encode83(componentX - 1 + (componentY - 1) * 9, 1);
  let maximumValue: number;
  if (ac.length > 0) {
    // The largest ABSOLUTE value, as the algorithm text specifies. The published npm package
    // (blurhash@2.0.5) takes the signed maximum instead, which clips dark-to-light gradients
    // badly (about 4x the error in our measurements). Hashes only differ when the largest
    // magnitude is negative; decoders are unaffected either way (they read the quantised scale).
    const actualMax = Math.max(...ac.flatMap((f) => f.map(Math.abs)));
    const quantisedMax = Math.max(0, Math.min(82, Math.floor(actualMax * 166 - 0.5)));
    maximumValue = (quantisedMax + 1) / 166;
    hash += encode83(quantisedMax, 1);
  } else {
    maximumValue = 1;
    hash += encode83(0, 1);
  }

  hash += encode83(
    (linearToSRGB(dc[0]) << 16) + (linearToSRGB(dc[1]) << 8) + linearToSRGB(dc[2]),
    4,
  );
  for (const f of ac) {
    const q = (v: number) =>
      Math.max(0, Math.min(18, Math.floor(signPow(v / maximumValue, 0.5) * 9 + 9.5)));
    hash += encode83(q(f[0]) * 19 * 19 + q(f[1]) * 19 + q(f[2]), 2);
  }
  return hash;
}

/** Components that suit the image's shape: more along the longer axis (max 9 total of 12). */
export function componentsFor(width: number, height: number): [number, number] {
  if (width <= 0 || height <= 0) return [4, 3];
  const ratio = width / height;
  if (ratio > 1.25) return [4, 3];
  if (ratio < 0.8) return [3, 4];
  return [4, 4];
}

/** Decoder, used by tests (round trip) and kept small; renders `punch`-neutral RGBA. */
export function decodeBlurhash(hash: string, width: number, height: number): Uint8ClampedArray {
  const sizeFlag = decode83(hash[0]!);
  const componentY = Math.floor(sizeFlag / 9) + 1;
  const componentX = (sizeFlag % 9) + 1;
  const quantisedMax = decode83(hash[1]!);
  const maximumValue = (quantisedMax + 1) / 166;

  const colors: Factor[] = [];
  for (let i = 0; i < componentX * componentY; i++) {
    if (i === 0) {
      const v = decode83(hash.slice(2, 6));
      colors.push([sRGBToLinear(v >> 16), sRGBToLinear((v >> 8) & 255), sRGBToLinear(v & 255)]);
    } else {
      const v = decode83(hash.slice(4 + i * 2, 6 + i * 2));
      const unq = (n: number) => signPow((n - 9) / 9, 2) * maximumValue;
      colors.push([unq(Math.floor(v / (19 * 19))), unq(Math.floor(v / 19) % 19), unq(v % 19)]);
    }
  }

  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < componentY; j++) {
        for (let i = 0; i < componentX; i++) {
          const basis = Math.cos((Math.PI * x * i) / width) * Math.cos((Math.PI * y * j) / height);
          const c = colors[i + j * componentX]!;
          r += c[0] * basis;
          g += c[1] * basis;
          b += c[2] * basis;
        }
      }
      const at = 4 * x + y * width * 4;
      out[at] = linearToSRGB(r);
      out[at + 1] = linearToSRGB(g);
      out[at + 2] = linearToSRGB(b);
      out[at + 3] = 255;
    }
  }
  return out;
}

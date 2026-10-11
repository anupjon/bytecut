import type { RawImage } from "../engines/types.js";
import type { RgbImage } from "./types.js";

/** True when any pixel is not fully opaque (an alpha channel can exist without being used). */
export function hasTransparency(image: RawImage): boolean {
  if (image.channels !== 4) return false;
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i]! < 255) return true;
  return false;
}

/** Composites over a flat background and drops alpha, giving what the scorer takes. */
export function flatten(image: RawImage, background: "white" | "black"): RgbImage {
  const { width, height, channels, data } = image;
  const out = new Uint8Array(width * height * 3);
  const base = background === "white" ? 255 : 0;
  for (let p = 0, i = 0, o = 0; p < width * height; p++, i += channels, o += 3) {
    const alpha = channels === 4 ? data[i + 3]! : 255;
    if (alpha === 255) {
      out[o] = data[i]!;
      out[o + 1] = data[i + 1]!;
      out[o + 2] = data[i + 2]!;
    } else {
      const a = alpha / 255;
      out[o] = Math.round(data[i]! * a + base * (1 - a));
      out[o + 1] = Math.round(data[i + 1]! * a + base * (1 - a));
      out[o + 2] = Math.round(data[i + 2]! * a + base * (1 - a));
    }
  }
  return { data: out, width, height };
}

export function dropAlpha(image: RawImage): RawImage {
  if (image.channels === 3) return image;
  const out = new Uint8Array(image.width * image.height * 3);
  for (let p = 0, i = 0, o = 0; p < image.width * image.height; p++, i += 4, o += 3) {
    out[o] = image.data[i]!;
    out[o + 1] = image.data[i + 1]!;
    out[o + 2] = image.data[i + 2]!;
  }
  return { data: out, width: image.width, height: image.height, channels: 3 };
}

export interface Window {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Mean absolute luma gradient over a window, sampled every other pixel. */
function detail(image: RawImage, w: Window): number {
  const { channels, data } = image;
  const luma = (x: number, y: number) => {
    const i = (y * image.width + x) * channels;
    return data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114;
  };
  let sum = 0;
  let count = 0;
  for (let y = w.y; y < w.y + w.height - 1; y += 2) {
    for (let x = w.x; x < w.x + w.width - 1; x += 2) {
      const l = luma(x, y);
      sum += Math.abs(luma(x + 1, y) - l) + Math.abs(luma(x, y + 1) - l);
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * The window of `size` px whose amount of detail is the median among the tiles of the image.
 * The busiest tile would over-spend bytes on a mostly flat image and the flattest would
 * under-spend on a textured one; the median is typical, and the full-size confirmation
 * catches whatever it misses. Deterministic: ties break by position.
 */
export function pickWindow(image: RawImage, size: number): Window {
  const w = Math.min(size, image.width);
  const h = Math.min(size, image.height);
  const nx = Math.max(1, Math.floor(image.width / w));
  const ny = Math.max(1, Math.floor(image.height / h));
  const ox = Math.floor((image.width - nx * w) / 2);
  const oy = Math.floor((image.height - ny * h) / 2);
  const tiles: Array<{ window: Window; detail: number; index: number }> = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const window = { x: ox + i * w, y: oy + j * h, width: w, height: h };
      tiles.push({ window, detail: detail(image, window), index: j * nx + i });
    }
  }
  tiles.sort((a, b) => a.detail - b.detail || a.index - b.index);
  return tiles[Math.floor((tiles.length - 1) / 2)]!.window;
}

export function crop(image: RawImage, w: Window): RawImage {
  const { channels } = image;
  const out = new Uint8Array(w.width * w.height * channels);
  for (let y = 0; y < w.height; y++) {
    const from = ((w.y + y) * image.width + w.x) * channels;
    out.set(image.data.subarray(from, from + w.width * channels), y * w.width * channels);
  }
  return { data: out, width: w.width, height: w.height, channels };
}

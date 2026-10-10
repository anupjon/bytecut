import type { ImagePreset } from "./photo.js";

/** Flat-colour art and logos: small widths, lossless so edges and flat fills stay exact. */
export const ICON_PRESET: ImagePreset = {
  name: "icon",
  widths: [64, 128, 256, 512],
  formats: ["avif", "webp"],
  encoders: {
    avif: { quality: 80, effort: 4 },
    webp: { quality: 90, effort: 4 },
  },
  lossless: true,
};

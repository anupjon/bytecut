import { OTHER_ENCODERS, type ImagePreset } from "./photo.js";

/** Flat-colour art and logos: small widths, lossless PNG so edges and flat fills stay exact. */
export const ICON_PRESET: ImagePreset = {
  name: "icon",
  widths: [64, 128, 256, 512],
  formats: ["png"],
  encoders: {
    ...OTHER_ENCODERS,
    jpg: { quality: 90, effort: 0 },
    avif: { quality: 80, effort: 4 },
    webp: { quality: 90, effort: 4 },
  },
  lossless: true,
};

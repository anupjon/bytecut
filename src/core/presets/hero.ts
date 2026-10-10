import type { ImagePreset } from "./photo.js";

/** Large above-the-fold images: an extra 2560 step and higher quality than `photo`. */
export const HERO_PRESET: ImagePreset = {
  name: "hero",
  widths: [640, 1280, 1920, 2560],
  formats: ["avif", "webp"],
  encoders: {
    avif: { quality: 65, effort: 4 },
    webp: { quality: 82, effort: 4 },
  },
  priority: true,
};

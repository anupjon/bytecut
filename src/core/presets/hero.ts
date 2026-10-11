import { OTHER_ENCODERS, type ImagePreset } from "./photo.js";

/** Large above-the-fold images: the same single size as `photo`, higher quality, high priority. */
export const HERO_PRESET: ImagePreset = {
  name: "hero",
  widths: [],
  maxEdge: 1920,
  formats: ["jpg"],
  encoders: {
    ...OTHER_ENCODERS,
    jpg: { quality: 85, effort: 0 },
    avif: { quality: 65, effort: 4 },
    webp: { quality: 82, effort: 4 },
  },
  priority: true,
};

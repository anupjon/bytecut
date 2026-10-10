import { BytecutError } from "../errors.js";
import { HERO_PRESET } from "./hero.js";
import { ICON_PRESET } from "./icon.js";
import { PHOTO_PRESET, type ImagePreset } from "./photo.js";

export { HERO_PRESET, ICON_PRESET, PHOTO_PRESET };
export type { ImageFormat, ImagePreset } from "./photo.js";

/** Raster image presets that `optimize` can execute today. */
export const IMAGE_PRESETS: Record<string, ImagePreset> = {
  photo: PHOTO_PRESET,
  hero: HERO_PRESET,
  icon: ICON_PRESET,
};

export function getImagePreset(name: string): ImagePreset {
  const preset = IMAGE_PRESETS[name];
  if (!preset) {
    throw new BytecutError(
      "BAD_ARGUMENTS",
      `Unknown preset "${name}". Image presets: ${Object.keys(IMAGE_PRESETS).join(", ")}.`,
    );
  }
  return preset;
}

import { IMAGE_PRESETS, type ImagePreset } from "./index.js";
import { VIDEO_PRESETS, type VideoPreset } from "./video.js";

/**
 * Every preset a run can use: the built-ins plus whatever the config defines. Resolution
 * (extends chains, targets, overrides) happens once, in the config layer; everything
 * downstream just looks names up.
 */
export interface PresetCatalog {
  image: Record<string, ImagePreset>;
  video: Record<string, VideoPreset>;
  /** The built-in each preset ultimately extends (a built-in maps to itself). */
  root: Record<string, string>;
  /** Presets the config defines or changes, for `explain`. */
  origin: Record<string, { chain: string[]; overrides: string[] }>;
}

export const BUILTIN_CATALOG: PresetCatalog = {
  image: IMAGE_PRESETS,
  video: VIDEO_PRESETS as Record<string, VideoPreset>,
  root: Object.fromEntries(
    [...Object.keys(IMAGE_PRESETS), ...Object.keys(VIDEO_PRESETS)].map((n) => [n, n]),
  ),
  origin: {},
};

/** A preset's name as the audit rules know it: the built-in it descends from. */
export function rootPreset(catalog: PresetCatalog | undefined, name: string): string {
  return catalog?.root[name] ?? name;
}

/** The catalog plus the `assets` rules: what the planner consults to pick a preset. */
export interface PresetPolicy {
  catalog: PresetCatalog;
  /** The first `assets` rule matching a project-relative POSIX path. */
  assetFor(source: string): { pattern: string; preset: string } | undefined;
}

export const BUILTIN_POLICY: PresetPolicy = {
  catalog: BUILTIN_CATALOG,
  assetFor: () => undefined,
};

import { BytecutError } from "../errors.js";
import { BUILTIN_CATALOG, type PresetCatalog } from "../presets/catalog.js";
import type { ImagePreset } from "../presets/photo.js";
import type { VideoPreset } from "../presets/video.js";
import { hint, type PresetConfig } from "./schema.js";

/**
 * What a quality `target` means. These are fixed numbers, not a search: the perceptual
 * search that picks quality per image is M9. `balanced` is the photo preset's own setting.
 */
export const IMAGE_TARGETS = {
  low: { avif: 45, webp: 65 },
  balanced: { avif: 60, webp: 78 },
  high: { avif: 75, webp: 88 },
} as const;
/** CRF offsets for video: higher CRF is smaller and worse. */
export const VIDEO_TARGET_CRF_OFFSET = { low: 4, balanced: 0, high: -4 } as const;

const IMAGE_ONLY = [
  "widths",
  "formats",
  "quality",
  "effort",
  "lossless",
  "priority",
  "ssimulacra2",
  "floor",
  "maxSize",
] as const;
const VIDEO_ONLY = ["audio", "maxWidth", "maxFps", "codecs", "crf"] as const;

function fail(message: string): never {
  throw new BytecutError("CONFIG_INVALID", `presets: ${message}`);
}

function applyImage(name: string, base: ImagePreset, def: PresetConfig): ImagePreset {
  for (const key of VIDEO_ONLY) {
    if (def[key] !== undefined) {
      fail(`"${name}" extends an image preset, so \`${key}\` (a video setting) does not apply.`);
    }
  }
  const next: ImagePreset = {
    ...base,
    name,
    widths: [...base.widths],
    formats: [...base.formats],
    encoders: { avif: { ...base.encoders.avif }, webp: { ...base.encoders.webp } },
  };
  if (def.target === "lossless") next.lossless = true;
  else if (def.target) {
    next.encoders.avif.quality = IMAGE_TARGETS[def.target].avif;
    next.encoders.webp.quality = IMAGE_TARGETS[def.target].webp;
  }
  if (def.widths) next.widths = [...new Set(def.widths)].sort((a, b) => a - b);
  if (def.formats) next.formats = [...new Set(def.formats)];
  if (def.quality?.avif !== undefined) next.encoders.avif.quality = def.quality.avif;
  if (def.quality?.webp !== undefined) next.encoders.webp.quality = def.quality.webp;
  if (def.effort?.avif !== undefined) next.encoders.avif.effort = def.effort.avif;
  if (def.effort?.webp !== undefined) next.encoders.webp.effort = def.effort.webp;
  if (def.lossless !== undefined) next.lossless = def.lossless;
  if (def.priority !== undefined) next.priority = def.priority;
  if (def.ssimulacra2 !== undefined) {
    next.search = {
      metric: "ssimulacra2",
      target: def.ssimulacra2,
      ...(def.floor !== undefined ? { floor: def.floor } : {}),
      ...(def.maxSize !== undefined ? { maxBytes: def.maxSize } : {}),
    };
  }
  return next;
}

function applyVideo(name: string, base: VideoPreset, def: PresetConfig): VideoPreset {
  for (const key of IMAGE_ONLY) {
    if (def[key] !== undefined) {
      fail(`"${name}" extends a video preset, so \`${key}\` (an image setting) does not apply.`);
    }
  }
  if (def.target === "lossless") {
    fail(`"${name}": \`target: "lossless"\` is not available for video; use "high".`);
  }
  const next: VideoPreset = {
    ...base,
    name,
    codecs: [...base.codecs],
    crf: { ...base.crf },
    speed: { ...base.speed },
    poster: { ...base.poster },
  };
  if (def.target) {
    const offset = VIDEO_TARGET_CRF_OFFSET[def.target];
    next.crf = { av1: base.crf.av1 + offset, h264: base.crf.h264 + offset };
  }
  if (def.crf?.av1 !== undefined) next.crf.av1 = def.crf.av1;
  if (def.crf?.h264 !== undefined) next.crf.h264 = def.crf.h264;
  if (def.codecs) next.codecs = [...new Set(def.codecs)];
  if (def.audio) next.audio = def.audio;
  if (def.maxWidth !== undefined) next.maxWidth = def.maxWidth;
  if (def.maxFps !== undefined) next.maxFps = def.maxFps;
  return next;
}

const CHANGE_KEYS = [...IMAGE_ONLY, ...VIDEO_ONLY, "target"] as const;

/**
 * Builds the catalog: built-ins plus the config's presets. A preset named like a built-in
 * and without `extends` changes that built-in; any other name must say what it extends.
 */
export function buildCatalog(defs: Record<string, PresetConfig> | undefined): PresetCatalog {
  const image: Record<string, ImagePreset> = { ...BUILTIN_CATALOG.image };
  const video: Record<string, VideoPreset> = { ...BUILTIN_CATALOG.video };
  const root: Record<string, string> = { ...BUILTIN_CATALOG.root };
  const origin: PresetCatalog["origin"] = {};
  if (!defs) return { image, video, root, origin };

  const builtinNames = new Set(Object.keys(BUILTIN_CATALOG.root));
  const done = new Set<string>();

  function resolve(name: string, stack: string[]): void {
    if (done.has(name)) return;
    const def = defs![name];
    if (!def) return;
    if (stack.includes(name)) fail(`extends cycle: ${[...stack, name].join(" → ")}.`);

    const parent = def.extends ?? (builtinNames.has(name) ? name : undefined);
    if (parent === undefined) {
      fail(
        `"${name}" must say what it extends, e.g. { "extends": "photo" }. Built-ins: ${[...builtinNames].join(", ")}.`,
      );
    }
    // `svg` is a built-in name in the spec, but there is no SVG output to configure yet.
    if (parent === "svg") fail(`"${name}" extends "svg", which has no output yet.`);
    if (parent === name) {
      // Changing a built-in in place: start from the built-in itself.
      if (!builtinNames.has(name)) fail(`"${name}" extends itself.`);
    } else if (defs![parent]) {
      resolve(parent, [...stack, name]);
    } else if (!builtinNames.has(parent)) {
      const known = [...builtinNames, ...Object.keys(defs!)];
      fail(`"${name}" extends unknown preset "${parent}"${hint(parent, known)}.`);
    }

    const baseName = parent === name ? name : parent;
    const chain: string[] = [];
    if (parent === name) chain.push(name);
    else chain.push(...(origin[parent]?.chain ?? [parent]), name);

    if (image[baseName]) {
      image[name] = applyImage(name, image[baseName]!, def);
    } else if (video[baseName]) {
      video[name] = applyVideo(name, video[baseName]!, def);
    } else {
      fail(`"${name}" extends "${baseName}", which is not an image or video preset.`);
    }
    root[name] = parent === name ? name : (root[parent] ?? parent);
    origin[name] = {
      chain,
      overrides: CHANGE_KEYS.filter((key) => def[key] !== undefined),
    };
    done.add(name);
  }

  for (const name of Object.keys(defs)) resolve(name, []);
  return { image, video, root, origin };
}

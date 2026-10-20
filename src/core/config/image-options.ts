import { BytecutError } from "../errors.js";
import type { PresetCatalog } from "../presets/catalog.js";
import type { ImageFormat, ImagePreset } from "../presets/photo.js";
import { formatBytes, parseSize } from "../units.js";

/**
 * The three questions the TUI asks once images are recognized. They apply to the lossy image
 * presets (`photo`, `hero` and presets built on them); `icon` stays lossless PNG.
 */
export interface ImageOptions {
  /** Lossy output formats, in canonical order; never empty. */
  formats: Array<"jpg" | "webp" | "avif">;
  /** Cap on the longest side, in pixels. */
  maxEdge: number;
  /** Cap on each output file, in bytes; turns on the perceptual search. */
  maxSize: number | null;
}

export const IMAGE_FORMAT_CHOICES = ["jpg", "webp", "avif"] as const;
export const MAX_EDGE_CHOICES = [1280, 1920, 2560, 3840] as const;
export const MAX_SIZE_CHOICES = [null, 150 * 1024, 300 * 1024, 500 * 1024, 1024 * 1024] as const;

export const IMAGE_OPTION_DEFAULTS: ImageOptions = {
  formats: ["jpg"],
  maxEdge: 1920,
  maxSize: null,
};

/**
 * What a size cap searches with when the preset has no target of its own. A cap needs a
 * quality to hold and a floor to stop at (the schema requires both); these are the README's.
 */
export const SEARCH_DEFAULTS = { ssimulacra2: 80, floor: 65 } as const;

/** The built-ins these options apply to. */
const LOSSY_ROOTS = new Set(["photo", "hero"]);

export const EDGE_LIMITS = { min: 16, max: 16384 } as const;

/** A typed max edge, or why it is not one (same bounds as the config schema). */
export function parseMaxEdge(text: string): number | string {
  const value = Number(text.trim().replace(/\s*px$/i, ""));
  if (!Number.isInteger(value) || value < EDGE_LIMITS.min || value > EDGE_LIMITS.max) {
    return `Max edge must be a whole number of pixels from ${EDGE_LIMITS.min} to ${EDGE_LIMITS.max}.`;
  }
  return value;
}

/** A typed max size, or why it is not one. */
export function parseMaxSize(text: string): number | string {
  const bytes = parseSize(text);
  if (bytes === null || bytes < 1024)
    return `"${text.trim()}" is not a size of at least 1 KB (try "250 KB").`;
  return bytes;
}

/** How a size is written into a config: readable, and parsed back to the same bytes. */
export function sizeForConfig(bytes: number): string | number {
  for (const [unit, factor] of [
    ["MB", 1024 ** 2],
    ["KB", 1024],
  ] as const) {
    if (bytes % factor === 0) return `${bytes / factor} ${unit}`;
  }
  return bytes;
}

/** `150 KB`, `1 MB`; an odd size falls back to `formatBytes`. */
export function describeMaxSize(bytes: number | null): string {
  if (bytes === null) return "no cap";
  const written = sizeForConfig(bytes);
  return typeof written === "string" ? written : formatBytes(bytes);
}

const lossyFormats = (formats: readonly ImageFormat[]): ImageOptions["formats"] => {
  const lossy = IMAGE_FORMAT_CHOICES.filter((f) => formats.includes(f));
  return lossy.length > 0 ? lossy : ["jpg"];
};

/** The options a preset currently amounts to; a preset using `widths` reads as its widest. */
export function optionsOf(preset: ImagePreset): ImageOptions {
  return {
    formats: lossyFormats(preset.formats),
    maxEdge:
      preset.maxEdge ??
      (preset.widths.length > 0 ? Math.max(...preset.widths) : IMAGE_OPTION_DEFAULTS.maxEdge),
    maxSize: preset.search?.maxBytes ?? null,
  };
}

/** What the project resolves to today, to pre-fill the questions. */
export function currentImageOptions(catalog: PresetCatalog): ImageOptions {
  const photo = catalog.image.photo;
  return photo ? optionsOf(photo) : { ...IMAGE_OPTION_DEFAULTS };
}

export function sameImageOptions(a: ImageOptions, b: ImageOptions): boolean {
  return (
    a.maxEdge === b.maxEdge &&
    a.maxSize === b.maxSize &&
    a.formats.length === b.formats.length &&
    a.formats.every((f, i) => b.formats[i] === f)
  );
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The config's `presets` (raw, as written in the file) with `options` applied, so that every
 * lossy image preset resolves to them. Fields are written only where they change something:
 * on `photo` and `hero` when they differ from what those resolve to now, and on a config
 * preset only where it sets the field itself and would otherwise shadow its parent. The
 * result is what the config layer validates and resolves, and what a save writes.
 */
export function applyImageOptions(
  rawPresets: unknown,
  catalog: PresetCatalog,
  options: ImageOptions,
): Raw {
  if (options.formats.length === 0) {
    throw new BytecutError("BAD_ARGUMENTS", "Choose at least one image format.");
  }
  const presets: Raw = isObject(rawPresets) ? { ...rawPresets } : {};
  const names = Object.keys(catalog.image).filter((name) =>
    LOSSY_ROOTS.has(catalog.root[name] ?? name),
  );

  for (const name of names) {
    const preset = catalog.image[name]!;
    const own = isObject(presets[name]) ? (presets[name] as Raw) : undefined;
    const builtin = LOSSY_ROOTS.has(name);
    // A config preset that leaves a field alone inherits it from the preset being changed.
    if (!builtin && !own) continue;
    const def: Raw = { ...own };
    const sets = (key: string) => builtin || (own !== undefined && key in own);
    const now = optionsOf(preset);

    if (sets("formats") && !sameList(now.formats, options.formats)) {
      // A PNG the config asked for stays: these questions are about the lossy formats.
      def.formats = [...options.formats, ...(preset.formats.includes("png") ? ["png"] : [])];
    }
    if ((sets("maxEdge") || sets("widths")) && now.maxEdge !== options.maxEdge) {
      delete def.widths;
      def.maxEdge = options.maxEdge;
    }

    const ownTarget = own !== undefined && "ssimulacra2" in own;
    if (
      (builtin || ownTarget || (own !== undefined && "maxSize" in own)) &&
      now.maxSize !== options.maxSize
    ) {
      if (options.maxSize === null) {
        delete def.maxSize;
        delete def.floor;
      } else {
        const target = preset.search?.target ?? SEARCH_DEFAULTS.ssimulacra2;
        if (!preset.search) def.ssimulacra2 = target;
        def.floor = preset.search?.floor ?? Math.min(SEARCH_DEFAULTS.floor, target);
        def.maxSize = sizeForConfig(options.maxSize);
      }
    }

    if (Object.keys(def).length > 0 || own) presets[name] = def;
  }
  return presets;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => b[i] === v);

/** Only the presets `applyImageOptions` changed, for a save that writes nothing else. */
export function changedPresets(before: unknown, after: Raw): Raw {
  const old = isObject(before) ? before : {};
  return Object.fromEntries(
    Object.entries(after).filter(
      ([name, def]) => JSON.stringify(old[name]) !== JSON.stringify(def),
    ),
  );
}

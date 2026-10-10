import type { ImageAnalysis } from "../engines/types.js";

export type ClassifiedPreset = "photo" | "hero" | "icon";

export interface Classification {
  preset: ClassifiedPreset;
  confidence: "high" | "medium" | "low";
  /** Human-readable, shown in dry-run output and audit details. */
  reason: string;
}

/** Few enough distinct (5-bit) colours in the sample that this is flat art, not a photograph. */
export const FLAT_COLOR_LIMIT = 64;
/** Icons and logos are small; a wide flat illustration should not be capped at icon widths. */
export const ICON_MAX_EDGE = 1024;
const HERO_NAME = /(^|[^a-z])(hero|banner|cover|header|splash|masthead|jumbotron)([^a-z]|$)/i;
const ICON_NAME = /(^|[^a-z])(icon|logo|favicon|sprite|glyph)([^a-z]|$)/i;

function baseName(source: string): string {
  const name = source.slice(source.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Pure heuristic. When unsure it answers `photo`, the conservative preset (§6.8): it keeps
 * quality settings that never destroy flat colour and never upscales.
 */
export function classify(source: string, a: ImageAnalysis): Classification {
  const name = baseName(source);
  const longEdge = Math.max(a.width, a.height);
  const flat = a.sampleSize > 0 && a.colorCount <= FLAT_COLOR_LIMIT;

  if (flat && longEdge <= ICON_MAX_EDGE) {
    const named = ICON_NAME.test(name);
    return {
      preset: "icon",
      confidence: named || a.alphaUsed || longEdge <= 512 ? "high" : "medium",
      reason: `flat art (${a.colorCount} colours in sample${a.alphaUsed ? ", uses transparency" : ""}${named ? `, name "${name}"` : ""})`,
    };
  }
  if (!flat && ICON_NAME.test(name) && longEdge <= 256) {
    return {
      preset: "icon",
      confidence: "medium",
      reason: `small image named "${name}" (${longEdge}px)`,
    };
  }

  if (HERO_NAME.test(name)) {
    return { preset: "hero", confidence: "high", reason: `name "${name}" looks like a hero image` };
  }
  if (a.width >= 1920 && a.width / Math.max(1, a.height) >= 1.6) {
    return {
      preset: "hero",
      confidence: "medium",
      reason: `large wide image (${a.width}x${a.height})`,
    };
  }

  const confident = a.colorCount > FLAT_COLOR_LIMIT * 2;
  return {
    preset: "photo",
    confidence: confident ? "high" : "low",
    reason: confident
      ? "continuous-tone image"
      : "ambiguous content; using the conservative preset",
  };
}

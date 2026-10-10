import { stringify as stringifyToml } from "smol-toml";
import type { PlaceholderKind } from "../placeholders/types.js";
import { escapeGlob } from "./glob.js";
import type { ConfigFormat } from "./load.js";

/**
 * Choices made in a session that a config file can make permanent. Only values that differ
 * from what the project already resolves to are ever written, so a config stays minimal.
 */
export interface Choices {
  outDir?: string | undefined;
  publicPath?: string | undefined;
  placeholder?: PlaceholderKind | "none" | undefined;
  /** Source path (POSIX, project-relative) → preset name. */
  presets?: Record<string, string> | undefined;
}

export function isEmpty(choices: Choices): boolean {
  return (
    choices.outDir === undefined &&
    choices.publicPath === undefined &&
    choices.placeholder === undefined &&
    Object.keys(choices.presets ?? {}).length === 0
  );
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `existing` with `choices` applied, as a plain object. Per-file presets go first in `assets`
 * because the first matching rule wins, and a file already named there is replaced.
 */
export function applyChoices(existing: unknown, choices: Choices): Raw {
  const next: Raw = isObject(existing) ? { ...existing } : {};
  if (choices.outDir !== undefined) next.outDir = choices.outDir;
  if (choices.publicPath !== undefined) next.publicPath = choices.publicPath;
  if (choices.placeholder !== undefined) {
    next.manifest = {
      ...(isObject(next.manifest) ? next.manifest : {}),
      placeholder: choices.placeholder,
    };
  }
  const presets = choices.presets ?? {};
  if (Object.keys(presets).length > 0) {
    const mine = Object.fromEntries(
      Object.entries(presets)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([source, preset]) => [escapeGlob(source), preset]),
    );
    const others = Object.entries(isObject(next.assets) ? next.assets : {}).filter(
      ([pattern]) => !(pattern in mine),
    );
    next.assets = { ...mine, ...Object.fromEntries(others) };
  }
  return next;
}

/** Whether a file of this format can be rewritten without losing anything the user wrote. */
export function canRewrite(format: ConfigFormat): boolean {
  return format === "json";
}

export function renderConfig(format: "json" | "toml" | "ts", data: Raw): string {
  if (format === "json") return `${JSON.stringify(data, null, 2)}\n`;
  if (format === "toml") return `${stringifyToml(data)}\n`;
  return `export default ${JSON.stringify(data, null, 2)};\n`;
}

/** The lines to add to a config that cannot be rewritten safely (TOML keeps comments, TS is code). */
export function renderChoicesSnippet(format: ConfigFormat, choices: Choices): string {
  const fragment = applyChoices({}, choices);
  return renderConfig(
    format === "toml" ? "toml" : format === "json" ? "json" : "ts",
    fragment,
  ).trimEnd();
}

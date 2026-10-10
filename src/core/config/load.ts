import { readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import { BytecutError } from "../errors.js";
import { CONFIG_FILES } from "./files.js";
import { parseConfig, type BytecutConfig } from "./schema.js";

export { CONFIG_FILES };

export type ConfigFormat = "ts" | "js" | "json" | "toml";

export interface LoadedConfig {
  /** Absolute path. */
  file: string;
  /** Path relative to the project root, as shown to the user. */
  name: string;
  format: ConfigFormat;
  config: BytecutConfig;
  /** The parsed file before validation, so a save can edit it without losing anything. */
  raw: unknown;
}

const formatOf = (file: string): ConfigFormat => {
  const ext = extname(file).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".toml") return "toml";
  return ext === ".ts" || ext === ".mts" ? "ts" : "js";
};

const invalid = (name: string, message: string, cause?: unknown) =>
  new BytecutError("CONFIG_INVALID", `${name}: ${message}`, cause ? { cause } : undefined);

/**
 * Importing the file runs it, which is what a `.ts` config is. Node prints an experimental
 * warning for type stripping on every import; it is noise for a config file, so drop only that.
 */
async function importConfig(file: string, name: string): Promise<unknown> {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/type stripping/i.test(text)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    let value = mod.default;
    if (typeof value === "function") value = await (value as () => unknown)();
    if (value === undefined || value === null || typeof value !== "object") {
      throw invalid(name, "must `export default` a config object");
    }
    return value;
  } catch (error) {
    if (error instanceof BytecutError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ERR_UNKNOWN_FILE_EXTENSION") {
      throw invalid(
        name,
        `this Node (${process.version}) cannot load TypeScript files. Use Node 22.18 or newer, or write the config as bytecut.config.json.`,
        error,
      );
    }
    if (code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
      throw invalid(
        name,
        `uses TypeScript syntax Node cannot strip (${message}). Keep the config a plain object.`,
        error,
      );
    }
    throw invalid(name, `could not be loaded: ${message}`, error);
  } finally {
    process.emitWarning = original;
  }
}

async function readRaw(file: string, name: string, format: ConfigFormat): Promise<unknown> {
  if (format === "ts" || format === "js") return importConfig(file, name);
  const text = await readFile(file, "utf8");
  try {
    return format === "json" ? (JSON.parse(text) as unknown) : parseToml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalid(name, `is not valid ${format === "json" ? "JSON" : "TOML"}: ${message}`, error);
  }
}

/** The config files present in `projectRoot`, in lookup order. */
export async function findConfigFiles(projectRoot: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of CONFIG_FILES) {
    const info = await stat(resolve(projectRoot, name)).catch(() => null);
    if (info?.isFile()) found.push(name);
  }
  return found;
}

/**
 * Loads and validates the project's config. `explicit` is `--config <path>`; without it the
 * root is searched. No config at all is `null` and behaves exactly like zero-config.
 */
export async function loadConfig(
  projectRoot: string,
  explicit?: string,
): Promise<LoadedConfig | null> {
  let file: string;
  if (explicit) {
    file = resolve(projectRoot, explicit);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      throw new BytecutError("INPUT_NOT_FOUND", `No such config file: ${explicit}`);
    }
  } else {
    const found = await findConfigFiles(projectRoot);
    if (found.length === 0) return null;
    if (found.length > 1) {
      throw new BytecutError(
        "CONFIG_INVALID",
        `More than one config file found (${found.join(", ")}). Keep one, or pick with --config.`,
      );
    }
    file = resolve(projectRoot, found[0]!);
  }

  const name = relative(projectRoot, file) || basename(file);
  const format = formatOf(file);
  const raw = await readRaw(file, name, format);
  return { file, name, format, config: parseConfig(raw, name), raw };
}

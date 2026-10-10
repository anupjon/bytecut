import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { walkFiles } from "./collect.js";

const TEXT_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".vue",
  ".svelte",
  ".astro",
  ".md",
  ".mdx",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".php",
  ".twig",
  ".liquid",
  ".njk",
  ".ejs",
  ".hbs",
  ".erb",
  ".txt",
]);
const SKIPPED_NAMES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const IMAGE_REFERENCE = /[\w@%+~.\-/\\]+\.(?:jpe?g|png|webp|avif|gif|svg)\b/gi;

export interface ReferenceScan {
  /** Lowercased basenames of every image-looking reference found. */
  names: Set<string>;
  filesScanned: number;
  /** True when the byte budget ran out, so absence of a reference means less. */
  truncated: boolean;
}

/**
 * Heuristic, name-based: an image counts as referenced if its file name appears in any
 * project text file. Dynamic references (`/img/${name}.jpg`) are invisible to it, which is
 * why `project/unreferenced` is only ever an `info`.
 */
export async function scanReferences(options: {
  cwd: string;
  outDir: string;
}): Promise<ReferenceScan> {
  const names = new Set<string>();
  let filesScanned = 0;
  let total = 0;
  let truncated = false;

  await walkFiles(options.cwd, options, async (path) => {
    if (truncated) return;
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || SKIPPED_NAMES.has(basename(path))) {
      return;
    }
    const info = await stat(path).catch(() => null);
    if (!info || info.size > MAX_FILE_BYTES) return;
    if (total + info.size > MAX_TOTAL_BYTES) {
      truncated = true;
      return;
    }
    total += info.size;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return;
    }
    filesScanned++;
    for (const match of text.matchAll(IMAGE_REFERENCE)) {
      let name = match[0].split(/[\\/]/).pop()!.toLowerCase();
      try {
        name = decodeURIComponent(name);
      } catch {
        // keep the raw name
      }
      names.add(name);
    }
  });

  return { names, filesScanned, truncated };
}

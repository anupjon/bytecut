import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { BytecutError } from "../errors.js";

const RASTER = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);
const VIDEO = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);
const SVG = new Set([".svg"]);
// Never descend into these (§6.15).
const ALWAYS_SKIPPED = new Set(["node_modules", ".git"]);

export interface CollectResult {
  /** Raster images, absolute paths, sorted. */
  files: string[];
  svgs: string[];
  videos: string[];
  /** Absolute paths of directories that were given as inputs. */
  sourceDirs: string[];
  /** Explicitly named files that can't be processed. */
  unsupported: string[];
}

interface Scope {
  /** Directory the .gitignore lives in. */
  base: string;
  matcher: Ignore;
}

/**
 * Deepest .gitignore wins, as in git. `ignore.test` reports `unignored` when a negation
 * pattern matched, which must stop us falling through to a shallower ignore.
 */
function isIgnored(scopes: Scope[], absolute: string, isDir: boolean): boolean {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i]!;
    const rel = relative(scope.base, absolute).split(sep).join("/");
    if (rel === "" || rel.startsWith("..")) continue;
    const verdict = scope.matcher.test(isDir ? `${rel}/` : rel);
    if (verdict.ignored) return true;
    if (verdict.unignored) return false;
  }
  return false;
}

async function loadScope(dir: string): Promise<Scope | null> {
  try {
    const text = await readFile(join(dir, ".gitignore"), "utf8");
    return { base: dir, matcher: ignore().add(text) };
  } catch {
    return null;
  }
}

/**
 * Walks `startDir` applying every .gitignore from the project root down (§6.15), never
 * descending into node_modules, .git or `outDir`, and never following symlinks.
 */
export async function walkFiles(
  startDir: string,
  options: { cwd: string; outDir: string },
  visit: (path: string) => void | Promise<void>,
): Promise<void> {
  async function walk(dir: string, inherited: Scope[]): Promise<void> {
    const own = await loadScope(dir);
    const scopes = own ? [...inherited, own] : inherited;
    // withFileTypes reports symlinks as neither file nor directory, so links are never followed.
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ALWAYS_SKIPPED.has(entry.name) || path === options.outDir) continue;
        if (isIgnored(scopes, path, true)) continue;
        await walk(path, scopes);
      } else if (entry.isFile()) {
        if (isIgnored(scopes, path, false)) continue;
        await visit(path);
      }
    }
  }

  // Scopes for every directory between the project root and `startDir`, so their ignore
  // rules still apply to what's inside it.
  const chain: Scope[] = [];
  const rel = relative(options.cwd, startDir);
  if (rel !== "" && !rel.startsWith("..")) {
    const rootScope = await loadScope(options.cwd);
    if (rootScope) chain.push(rootScope);
    let current = options.cwd;
    for (const part of rel.split(sep).slice(0, -1)) {
      current = join(current, part);
      const scope = await loadScope(current);
      if (scope) chain.push(scope);
    }
  }
  await walk(startDir, chain);
}

export async function collectAssets(
  inputs: string[],
  options: { cwd: string; outDir: string },
): Promise<CollectResult> {
  const files = new Set<string>();
  const svgs = new Set<string>();
  const videos = new Set<string>();
  const sourceDirs: string[] = [];
  const unsupported: string[] = [];

  function classify(path: string, explicit: boolean): void {
    const ext = extname(path).toLowerCase();
    if (RASTER.has(ext)) files.add(path);
    else if (SVG.has(ext)) svgs.add(path);
    else if (VIDEO.has(ext)) videos.add(path);
    else if (explicit) unsupported.push(path);
  }

  for (const input of inputs) {
    const absolute = resolve(options.cwd, input);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new BytecutError("INPUT_NOT_FOUND", `No such file or folder: ${input}`);

    if (info.isDirectory()) {
      sourceDirs.push(absolute);
      if (absolute !== options.outDir)
        await walkFiles(absolute, options, (p) => classify(p, false));
    } else {
      // Naming a file explicitly is an instruction: .gitignore does not veto it.
      classify(absolute, true);
    }
  }

  const sorted = (s: Set<string>) => [...s].sort();
  return {
    files: sorted(files),
    svgs: sorted(svgs),
    videos: sorted(videos),
    sourceDirs,
    unsupported,
  };
}

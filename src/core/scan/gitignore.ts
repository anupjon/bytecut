import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ignore from "ignore";

/**
 * Whether git would ignore `absolute` (a folder), by the .gitignore files from the project
 * root down to it. Used to tell the user that outputs meant to be committed are ignored.
 */
export async function isGitIgnored(projectRoot: string, absolute: string): Promise<boolean> {
  const rel = relative(projectRoot, absolute);
  if (rel === "" || rel.startsWith("..")) return false;
  const parts = rel.split(sep);
  let dir = projectRoot;
  const scopes: Array<{ base: string; matcher: ReturnType<typeof ignore> }> = [];
  for (let i = 0; i < parts.length; i++) {
    const text = await readFile(join(dir, ".gitignore"), "utf8").catch(() => null);
    if (text !== null) scopes.push({ base: dir, matcher: ignore().add(text) });
    dir = join(dir, parts[i]!);
    // An ignored ancestor ignores everything beneath it; the deepest verdict wins otherwise.
    for (let s = scopes.length - 1; s >= 0; s--) {
      const scope = scopes[s]!;
      const verdict = scope.matcher.test(`${relative(scope.base, dir).split(sep).join("/")}/`);
      if (verdict.ignored) return true;
      if (verdict.unignored) break;
    }
  }
  return false;
}

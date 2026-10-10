/**
 * A small glob matcher for `assets` and `audit.ignore`, matched against POSIX paths relative
 * to the project root. Supported: `*` (within a segment), `**` (across segments), `?`,
 * `{a,b}` and `[abc]`/`[!abc]`. A backslash escapes the next character, which is how an
 * exact file name containing glob characters is written.
 *
 * Like .gitignore, a pattern without a slash matches the file name at any depth, because
 * `"*.mp4": "content-video"` is what people type and expect.
 */

const SPECIAL = /[\\^$.|+()]/;

/** `{`/`}` are alternation only when they pair up; otherwise they are ordinary characters. */
function bracesPair(pattern: string): boolean {
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") i++;
    else if (pattern[i] === "{") depth++;
    else if (pattern[i] === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

function translate(pattern: string): string {
  let out = "";
  let braceDepth = 0;
  const alternation = bracesPair(pattern);
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[++i];
      if (next !== undefined) out += next.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
    } else if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        // `**/` also matches nothing, so `a/**/b` matches `a/b`.
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (ch === "{" && alternation) {
      braceDepth++;
      out += "(?:";
    } else if (ch === "}" && alternation) {
      braceDepth--;
      out += ")";
    } else if (ch === "," && braceDepth > 0) out += "|";
    else if (ch === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end === -1) out += "\\[";
      else {
        let body = pattern.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (SPECIAL.test(ch) || ch === "{" || ch === "}") out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

export function hasSlash(pattern: string): boolean {
  return pattern.replace(/\\./g, "").includes("/");
}

export function globToRegExp(pattern: string): RegExp {
  const body = translate(pattern.replace(/^\.\//, ""));
  return new RegExp(hasSlash(pattern) ? `^${body}$` : `^(?:.*/)?${body}$`);
}

export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

/** Escapes a literal path so it matches only itself, however odd its characters. */
export function escapeGlob(path: string): string {
  return path.replace(/[\\*?[\]{}]/g, "\\$&");
}

/** Whether a pattern contains an unescaped wildcard (so it can match more than one file). */
export function isLiteral(pattern: string): boolean {
  return !/(^|[^\\])(\\\\)*[*?[\]{}]/.test(pattern);
}

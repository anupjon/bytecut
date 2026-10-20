export interface CommandInfo {
  name: string;
  usage: string;
  description: string;
}

export const COMMANDS: CommandInfo[] = [
  { name: "audit", usage: "/audit", description: "Rescan the project" },
  {
    name: "optimize",
    usage: "/optimize [@file…]",
    description: "Review the plan for the selection (or the mentioned files)",
  },
  {
    name: "preset",
    usage: "/preset <preset> [@file…]",
    description: "Set the preset for the highlighted (or mentioned) files",
  },
  {
    name: "snippet",
    usage: "/snippet @file",
    description: "Copy the <picture>/<video> markup for an optimized file",
  },
  {
    name: "compare",
    usage: "/compare @file",
    description: "Serve a before/after page for an optimized file on localhost",
  },
  {
    name: "save",
    usage: "/save",
    description: "Keep this session's preset, image and folder choices in the project config",
  },
  {
    name: "images",
    usage: "/images",
    description: "Choose image formats, max edge and max size per file",
  },
  { name: "out", usage: "/out <dir>", description: "Change the output folder" },
  { name: "select", usage: "/select <all|none|warn>", description: "Change the selection" },
  { name: "doctor", usage: "/doctor", description: "Show Node, sharp and ffmpeg status" },
  { name: "help", usage: "/help", description: "Show keys and commands" },
  { name: "quit", usage: "/quit", description: "Leave bytecut" },
];

export type ParsedCommand =
  { ok: true; name: string; args: string[]; mentions: string[] } | { ok: false; error: string };

/**
 * `/preset hero @public/img/a.jpg` → name `preset`, args `["hero"]`, mentions
 * `["public/img/a.jpg"]`. Mentions are the only way the command bar refers to files.
 */
export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { ok: false, error: "Commands start with / (try /help)" };
  }
  const tokens = trimmed.slice(1).split(/\s+/).filter(Boolean);
  const name = tokens.shift()?.toLowerCase() ?? "";
  if (!name) return { ok: false, error: "Type a command after / (try /help)" };
  if (!COMMANDS.some((c) => c.name === name)) {
    return { ok: false, error: `Unknown command /${name} (try /help)` };
  }
  const args: string[] = [];
  const mentions: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("@") && token.length > 1) mentions.push(token.slice(1));
    else args.push(token);
  }
  return { ok: true, name, args, mentions };
}

/** Commands whose name starts with what has been typed after the `/`. */
export function suggestCommands(text: string): CommandInfo[] {
  const m = /^\/(\S*)$/.exec(text.trimStart());
  if (!m) return [];
  const prefix = m[1]!.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(prefix));
}

/** The `@token` being typed at the end of the input, without the `@`; null if none. */
export function activeMention(text: string): string | null {
  const m = /(?:^|\s)@(\S*)$/.exec(text);
  return m ? m[1]! : null;
}

/** Greedy subsequence match of `q` in `text`, with bonuses for runs and word starts. */
function subsequenceScore(q: string, text: string): number | null {
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of q) {
    const at = text.indexOf(ch, from);
    if (at === -1) return null;
    score += 1;
    if (at === previous + 1) score += 3;
    if (at === 0 || "/-_. ".includes(text[at - 1]!)) score += 2;
    previous = at;
    from = at + 1;
  }
  return score;
}

/**
 * Scored for the way people type paths. The file name is matched on its own first, because a
 * greedy match over the whole path can latch onto an earlier letter in a folder name (the `g`
 * in `img/` instead of the `g` in `gps.jpg`). A hit in the name beats one only in the path.
 */
export function fuzzyScore(query: string, path: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const name = p.slice(p.lastIndexOf("/") + 1);

  const inName = subsequenceScore(q, name);
  const inPath = subsequenceScore(q, p);
  if (inName === null && inPath === null) return null;

  let score = inName !== null ? inName + 8 : (inPath ?? 0);
  if (inName !== null && inPath !== null) score = Math.max(score, inPath);
  if (name.includes(q)) score += 10;
  if (name.startsWith(q)) score += 4;
  // Shorter paths first among equals.
  return score * 100 - path.length;
}

export function fuzzyFiles(query: string, files: string[], limit = 8): string[] {
  return files
    .map((file) => ({ file, score: fuzzyScore(query, file) }))
    .filter((x): x is { file: string; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.file);
}

/** Replaces the active `@token` with the chosen file, leaving a space for the next token. */
export function completeMention(text: string, file: string): string {
  return text.replace(/(^|\s)@\S*$/, `$1@${file} `);
}

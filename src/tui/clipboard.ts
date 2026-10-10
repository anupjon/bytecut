import { spawn } from "node:child_process";

export type CopyMethod = "pbcopy" | "clip" | "wl-copy" | "xclip" | "xsel" | "osc52";

export type CopyResult =
  | { ok: true; method: CopyMethod }
  /** Nothing could take the text; the caller must show it so the user can copy by hand. */
  | { ok: false };

export interface ClipboardDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Runs `file args` with `input` on stdin; resolves true on exit code 0, false otherwise. */
  run(file: string, args: string[], input: string): Promise<boolean>;
  /** Writes raw bytes to the terminal; null when stdout is not a terminal. */
  writeTerminal: ((data: string) => void) | null;
}

interface Candidate {
  method: Exclude<CopyMethod, "osc52">;
  file: string;
  args: string[];
}

/** In preference order for this platform. Arguments are arrays, never a shell string (§6.14). */
export function candidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): Candidate[] {
  switch (platform) {
    case "darwin":
      return [{ method: "pbcopy", file: "pbcopy", args: [] }];
    case "win32":
      return [{ method: "clip", file: "clip", args: [] }];
    default: {
      const list: Candidate[] = [];
      if (env.WAYLAND_DISPLAY) list.push({ method: "wl-copy", file: "wl-copy", args: [] });
      list.push({ method: "xclip", file: "xclip", args: ["-selection", "clipboard"] });
      list.push({ method: "xsel", file: "xsel", args: ["--clipboard", "--input"] });
      if (!env.WAYLAND_DISPLAY) list.push({ method: "wl-copy", file: "wl-copy", args: [] });
      return list;
    }
  }
}

/** OSC 52: asks the terminal itself to set the clipboard, so it works over SSH. */
export function osc52(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}

/** Hard cap: terminals disagree on how much OSC 52 they accept, and a snippet is small. */
const OSC52_MAX_BYTES = 100_000;

export async function copyToClipboard(text: string, deps: ClipboardDeps): Promise<CopyResult> {
  for (const c of candidates(deps.platform, deps.env)) {
    if (await deps.run(c.file, c.args, text)) return { ok: true, method: c.method };
  }
  if (deps.writeTerminal && Buffer.byteLength(text) <= OSC52_MAX_BYTES) {
    // There is no acknowledgement for OSC 52; terminals that don't support it ignore it.
    deps.writeTerminal(osc52(text));
    return { ok: true, method: "osc52" };
  }
  return { ok: false };
}

/** The real thing: a missing tool is just `false`, never an exception. */
export function systemClipboardDeps(): ClipboardDeps {
  return {
    platform: process.platform,
    env: process.env,
    run: (file, args, input) =>
      new Promise((resolve) => {
        let settled = false;
        const done = (value: boolean) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        try {
          const child = spawn(file, args, { stdio: ["pipe", "ignore", "ignore"] });
          const timer = setTimeout(() => {
            child.kill();
            done(false);
          }, 2000);
          child.on("error", () => {
            clearTimeout(timer);
            done(false);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            done(code === 0);
          });
          child.stdin.on("error", () => done(false));
          child.stdin.end(input);
        } catch {
          done(false);
        }
      }),
    writeTerminal: process.stdout.isTTY ? (data) => void process.stdout.write(data) : null,
  };
}

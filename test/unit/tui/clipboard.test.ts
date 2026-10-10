import { describe, expect, it } from "vitest";
import {
  candidates,
  copyToClipboard,
  osc52,
  type ClipboardDeps,
} from "../../../src/tui/clipboard.js";

function deps(over: Partial<ClipboardDeps> & { works?: string[] } = {}) {
  const calls: Array<{ file: string; args: string[]; input: string }> = [];
  const written: string[] = [];
  const { works = [], ...rest } = over;
  const d: ClipboardDeps = {
    platform: "linux",
    env: {},
    async run(file, args, input) {
      calls.push({ file, args, input });
      return works.includes(file);
    },
    writeTerminal: (data) => void written.push(data),
    ...rest,
  };
  return { d, calls, written };
}

describe("candidates", () => {
  it("is one native tool on macOS and Windows", () => {
    expect(candidates("darwin", {}).map((c) => c.file)).toEqual(["pbcopy"]);
    expect(candidates("win32", {}).map((c) => c.file)).toEqual(["clip"]);
  });

  it("prefers wl-copy on Wayland and X11 tools otherwise, with the clipboard selection", () => {
    expect(candidates("linux", { WAYLAND_DISPLAY: "wayland-0" }).map((c) => c.file)).toEqual([
      "wl-copy",
      "xclip",
      "xsel",
    ]);
    const x11 = candidates("linux", {});
    expect(x11.map((c) => c.file)).toEqual(["xclip", "xsel", "wl-copy"]);
    expect(x11[0]!.args).toEqual(["-selection", "clipboard"]);
    expect(x11[1]!.args).toEqual(["--clipboard", "--input"]);
  });
});

describe("copyToClipboard", () => {
  it("uses the first tool that works and sends the text on stdin, not in the arguments", async () => {
    const { d, calls } = deps({ works: ["xsel"] });
    const text = '<img alt="; rm -rf ~">';
    const result = await copyToClipboard(text, d);
    expect(result).toEqual({ ok: true, method: "xsel" });
    expect(calls.map((c) => c.file)).toEqual(["xclip", "xsel"]); // tried in order, stopped at success
    expect(calls.every((c) => c.input === text)).toBe(true);
    expect(calls.every((c) => !c.args.some((a) => a.includes("rm -rf")))).toBe(true);
  });

  it("falls back to OSC 52 when no tool works, and says so", async () => {
    const { d, written } = deps({ works: [] });
    const result = await copyToClipboard("hello", d);
    expect(result).toEqual({ ok: true, method: "osc52" });
    expect(written).toEqual([osc52("hello")]);
    expect(written[0]).toBe(`\u001b]52;c;${Buffer.from("hello").toString("base64")}\u0007`);
  });

  it("reports failure, writing nothing, when there is no tool and no terminal", async () => {
    const { d, written } = deps({ works: [], writeTerminal: null });
    expect(await copyToClipboard("hello", d)).toEqual({ ok: false });
    expect(written).toEqual([]);
  });

  it("does not send an enormous payload through the terminal", async () => {
    const { d, written } = deps({ works: [] });
    expect(await copyToClipboard("x".repeat(200_000), d)).toEqual({ ok: false });
    expect(written).toEqual([]);
  });

  it("encodes non-ASCII text as UTF-8 in OSC 52", () => {
    expect(osc52("é")).toBe(`\u001b]52;c;${Buffer.from("é", "utf8").toString("base64")}\u0007`);
  });
});

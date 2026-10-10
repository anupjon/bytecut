import { describe, expect, it } from "vitest";
import {
  activeMention,
  completeMention,
  COMMANDS,
  fuzzyFiles,
  fuzzyScore,
  parseCommand,
  suggestCommands,
} from "../../../src/tui/commands.js";

describe("parseCommand", () => {
  it("splits name, arguments and @mentions", () => {
    expect(parseCommand("/preset hero @public/img/a.jpg @b.png")).toEqual({
      ok: true,
      name: "preset",
      args: ["hero"],
      mentions: ["public/img/a.jpg", "b.png"],
    });
  });

  it("is case-insensitive on the command name and tolerant of spacing", () => {
    expect(parseCommand("  /AUDIT   ")).toEqual({
      ok: true,
      name: "audit",
      args: [],
      mentions: [],
    });
  });

  it("rejects text that is not a command, and unknown commands, with a hint", () => {
    expect(parseCommand("audit")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/start with \//),
    });
    expect(parseCommand("/")).toMatchObject({ ok: false });
    expect(parseCommand("/nope")).toMatchObject({
      ok: false,
      error: "Unknown command /nope (try /help)",
    });
  });

  it("treats a lone @ as an argument, not a mention", () => {
    expect(parseCommand("/optimize @")).toMatchObject({ ok: true, args: ["@"], mentions: [] });
  });

  it("knows every command it advertises", () => {
    for (const c of COMMANDS) expect(parseCommand(`/${c.name}`)).toMatchObject({ ok: true });
  });
});

describe("suggestCommands", () => {
  it("lists everything for a bare slash and filters by prefix", () => {
    expect(suggestCommands("/")).toHaveLength(COMMANDS.length);
    expect(suggestCommands("/pre").map((c) => c.name)).toEqual(["preset"]);
    expect(suggestCommands("/o").map((c) => c.name)).toEqual(["optimize", "out"]);
  });

  it("offers nothing once arguments are being typed or for non-commands", () => {
    expect(suggestCommands("/preset hero")).toEqual([]);
    expect(suggestCommands("hello")).toEqual([]);
    expect(suggestCommands("/zzz")).toEqual([]);
  });
});

describe("activeMention / completeMention", () => {
  it("finds the @token at the end of the input", () => {
    expect(activeMention("/preset hero @gp")).toBe("gp");
    expect(activeMention("@")).toBe("");
    expect(activeMention("/preset hero")).toBeNull();
    expect(activeMention("/preset @a.jpg done")).toBeNull();
  });

  it("replaces only the active token", () => {
    expect(completeMention("/preset hero @gp", "public/img/gps.jpg")).toBe(
      "/preset hero @public/img/gps.jpg ",
    );
    expect(completeMention("@a", "x/a.jpg")).toBe("@x/a.jpg ");
    expect(completeMention("/optimize @one.jpg @tw", "two.jpg")).toBe(
      "/optimize @one.jpg @two.jpg ",
    );
  });
});

describe("fuzzy file matching", () => {
  const files = [
    "public/img/hero-banner.jpg",
    "public/img/gps.jpg",
    "public/img/photo.jpg",
    "public/hero/banner.jpg",
    "src/assets/gps-map.png",
  ];

  it("returns nothing for a query that is not a subsequence", () => {
    expect(fuzzyScore("zzz", "public/img/a.jpg")).toBeNull();
    expect(fuzzyFiles("zzz", files)).toEqual([]);
  });

  it("matches subsequences across the path", () => {
    expect(fuzzyFiles("pimgp", files)).toContain("public/img/photo.jpg");
  });

  it("prefers a file-name hit over a folder hit", () => {
    // "hero" is in both paths' folders/names; the file whose *name* contains it wins.
    expect(fuzzyFiles("hero", files)[0]).toBe("public/img/hero-banner.jpg");
  });

  it("prefers consecutive characters and shorter paths", () => {
    expect(fuzzyFiles("gps", files)[0]).toBe("public/img/gps.jpg");
  });

  it("returns everything (bounded) for an empty query, and respects the limit", () => {
    expect(fuzzyFiles("", files, 3)).toHaveLength(3);
  });

  it("is case-insensitive", () => {
    expect(fuzzyFiles("PHOTO", files)).toEqual(["public/img/photo.jpg"]);
  });
});

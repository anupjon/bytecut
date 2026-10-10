import { describe, expect, it } from "vitest";
import {
  applyChoices,
  canRewrite,
  isEmpty,
  renderChoicesSnippet,
  renderConfig,
} from "../../../src/core/config/choices.js";
import { matchesGlob } from "../../../src/core/config/glob.js";

describe("applyChoices", () => {
  it("writes only what was chosen", () => {
    expect(applyChoices({}, { presets: { "public/a.jpg": "icon" } })).toEqual({
      assets: { "public/a.jpg": "icon" },
    });
    expect(applyChoices({}, { outDir: "out" })).toEqual({ outDir: "out" });
    expect(applyChoices({}, { placeholder: "lqip" })).toEqual({
      manifest: { placeholder: "lqip" },
    });
  });

  it("puts new per-file rules before existing ones, because the first match wins", () => {
    const next = applyChoices(
      { assets: { "public/**": "photo" } },
      { presets: { "public/a.jpg": "icon" } },
    );
    expect(Object.keys(next.assets as object)).toEqual(["public/a.jpg", "public/**"]);
    expect(matchesGlob(Object.keys(next.assets as object)[0]!, "public/a.jpg")).toBe(true);
  });

  it("replaces an existing rule for the same file instead of duplicating it", () => {
    const next = applyChoices(
      { assets: { "public/a.jpg": "photo", "public/b.jpg": "hero" } },
      { presets: { "public/a.jpg": "icon" } },
    );
    expect(next.assets).toEqual({ "public/a.jpg": "icon", "public/b.jpg": "hero" });
  });

  it("escapes glob characters so a rule matches only its file", () => {
    const next = applyChoices({}, { presets: { "img/a[1].jpg": "icon" } });
    expect(Object.keys(next.assets as object)).toEqual(["img/a\\[1\\].jpg"]);
  });

  it("keeps everything else in the file, and does not mutate its input", () => {
    const existing = {
      outDir: "x",
      budgets: { maxFileSize: "1 MB" },
      manifest: { placeholder: "blurhash" },
    };
    const copy = JSON.parse(JSON.stringify(existing));
    const next = applyChoices(existing, { placeholder: "lqip" });
    expect(next).toEqual({
      outDir: "x",
      budgets: { maxFileSize: "1 MB" },
      manifest: { placeholder: "lqip" },
    });
    expect(existing).toEqual(copy);
  });

  it("is deterministic: sorted rules, stable JSON", () => {
    const a = renderConfig(
      "json",
      applyChoices({}, { presets: { "b.jpg": "icon", "a.jpg": "hero" } }),
    );
    const b = renderConfig(
      "json",
      applyChoices({}, { presets: { "a.jpg": "hero", "b.jpg": "icon" } }),
    );
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
  });
});

describe("what can be rewritten", () => {
  it("rewrites only JSON; TOML keeps comments and TS is code", () => {
    expect(canRewrite("json")).toBe(true);
    expect(canRewrite("toml")).toBe(false);
    expect(canRewrite("ts")).toBe(false);
    expect(canRewrite("js")).toBe(false);
  });

  it("renders the lines to add in the file's own syntax", () => {
    const choices = { presets: { "a.jpg": "icon" }, outDir: "out" };
    expect(renderChoicesSnippet("toml", choices)).toContain("[assets]");
    expect(renderChoicesSnippet("toml", choices)).toContain('"a.jpg" = "icon"');
    expect(renderChoicesSnippet("ts", choices)).toMatch(/^export default \{/);
  });

  it("knows when there is nothing to save", () => {
    expect(isEmpty({})).toBe(true);
    expect(isEmpty({ presets: {} })).toBe(true);
    expect(isEmpty({ outDir: "x" })).toBe(false);
  });
});

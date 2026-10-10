import { describe, expect, it } from "vitest";
import { buildSnippet } from "../../src/core/snippets/build.js";
import { snippetFormatFor } from "../../src/core/snippets/format.js";
import type { Framework } from "../../src/core/scan/detect.js";
import { heroEntry, manifestWith, photoEntry, videoEntry } from "../snippets-fixtures.js";

/**
 * Every case, for every framework, as one readable document per framework. Update intentionally
 * with `-u`. The manifest is hand-written, so these do not depend on any encoder.
 */
const manifest = manifestWith(
  {
    "public/img/photo.jpg": photoEntry(),
    "public/img/hero.jpg": heroEntry(),
  },
  {
    "public/v/background.mp4": videoEntry("background-video"),
    "public/v/clip.mp4": videoEntry("content-video", true),
    "public/v/spinner.gif": videoEntry("gif-to-video"),
  },
);

const cases: Array<{ title: string; source: string; options: Record<string, unknown> }> = [
  { title: "image (lazy)", source: "public/img/photo.jpg", options: {} },
  {
    title: "image with alt, class and sizes",
    source: "public/img/photo.jpg",
    options: { alt: "A purple field", className: "card", sizes: "(min-width: 768px) 50vw, 100vw" },
  },
  { title: "hero image (priority)", source: "public/img/hero.jpg", options: { alt: "Skyline" } },
  { title: "background video", source: "public/v/background.mp4", options: {} },
  { title: "content video", source: "public/v/clip.mp4", options: {} },
  { title: "GIF replacement", source: "public/v/spinner.gif", options: { className: "spinner" } },
];

const frameworks: Array<{ name: string; project: { framework: Framework; react: boolean } }> = [
  { name: "next", project: { framework: "next", react: true } },
  { name: "astro", project: { framework: "astro", react: false } },
  { name: "vite-react", project: { framework: "vite", react: true } },
  { name: "vite", project: { framework: "vite", react: false } },
  { name: "static", project: { framework: "static", react: false } },
];

describe("snippets (golden)", () => {
  it.each(frameworks)("$name", async ({ name, project }) => {
    const format = snippetFormatFor(project);
    const sections = cases.map(({ title, source, options }) => {
      const snippet = buildSnippet(
        manifest,
        { source, originalUrl: `/${source.replace(/^public\//, "")}` },
        { format, ...options },
      )!;
      return `<!-- ${title} -->\n${snippet.code}`;
    });
    const ext = format === "jsx" ? "jsx" : "html";
    await expect(`${sections.join("\n\n")}\n`).toMatchFileSnapshot(`./snippets/${name}.${ext}`);
  });

  it("Astro is plain HTML, not JSX", () => {
    const astro = buildSnippet(
      manifest,
      { source: "public/img/hero.jpg", originalUrl: "/img/hero.jpg" },
      { format: snippetFormatFor({ framework: "astro", react: true }) },
    )!;
    expect(astro.code).toContain("fetchpriority=");
    expect(astro.code).not.toContain("fetchPriority");
    expect(astro.code).not.toContain("/>");
  });
});

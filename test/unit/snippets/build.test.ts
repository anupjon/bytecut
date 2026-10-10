import { describe, expect, it } from "vitest";
import { buildSnippet, type SnippetOptions } from "../../../src/core/snippets/build.js";
import { snippetFormatFor } from "../../../src/core/snippets/format.js";
import { heroEntry, image, manifestWith, photoEntry, videoEntry } from "../../snippets-fixtures.js";

const target = (source: string) => ({ source, originalUrl: `/${source.replace(/^public\//, "")}` });
const build = (
  entries: Parameters<typeof manifestWith>,
  source: string,
  options: Partial<SnippetOptions> = {},
) => buildSnippet(manifestWith(...entries), target(source), { format: "html", ...options })!;

describe("image snippets", () => {
  const photo = (over = {}, opts: Partial<SnippetOptions> = {}) =>
    build([{ "public/img/photo.jpg": photoEntry(over) }], "public/img/photo.jpg", opts);

  it("lists every width per format, smallest first, AVIF before WebP", () => {
    const { code } = photo();
    const avif = code.indexOf('type="image/avif"');
    const webp = code.indexOf('type="image/webp"');
    expect(avif).toBeGreaterThan(-1);
    expect(avif).toBeLessThan(webp);
    expect(code).toContain(
      'srcset="/_bytecut/img/photo/photo-640.avif 640w, /_bytecut/img/photo/photo-1280.avif 1280w, /_bytecut/img/photo/photo-1400.avif 1400w"',
    );
  });

  it("falls back to the LARGEST WebP and takes its dimensions (confirmed decision)", () => {
    const { code } = photo();
    expect(code).toContain(
      '<img src="/_bytecut/img/photo/photo-1400.webp" width="1400" height="900"',
    );
  });

  it("is lazy and async by default, and explicit about sizes", () => {
    const { code } = photo();
    expect(code).toContain('loading="lazy"');
    expect(code).toContain('decoding="async"');
    expect(code).not.toContain("fetchpriority");
    expect(code.match(/sizes="100vw"/g)).toHaveLength(2);
  });

  it("a priority preset emits fetchpriority=high and NO lazy loading", () => {
    const { code } = build([{ "public/img/hero.jpg": heroEntry() }], "public/img/hero.jpg");
    expect(code).toContain('fetchpriority="high"');
    expect(code).not.toContain("loading=");
    expect(code).toContain('decoding="async"');
  });

  it("--priority and --lazy override the preset in both directions", () => {
    expect(photo({}, { priority: true }).code).toContain('fetchpriority="high"');
    expect(photo({}, { priority: true }).code).not.toContain("loading=");
    const hero = build([{ "public/img/hero.jpg": heroEntry() }], "public/img/hero.jpg", {
      priority: false,
    });
    expect(hero.code).not.toContain("fetchpriority");
    expect(hero.code).toContain('loading="lazy"');
    const lazyHero = build([{ "public/img/hero.jpg": heroEntry() }], "public/img/hero.jpg", {
      lazy: true,
    });
    expect(lazyHero.code).toContain('fetchpriority="high"');
    expect(lazyHero.code).toContain('loading="lazy"');
  });

  it("uses alt, class and sizes when given, and hints when alt is missing", () => {
    const withAll = photo(
      {},
      { alt: "A cat", className: "card", sizes: "(min-width: 768px) 50vw, 100vw" },
    );
    expect(withAll.code).toContain('alt="A cat"');
    expect(withAll.code).toContain('class="card"');
    expect(withAll.code).toContain('sizes="(min-width: 768px) 50vw, 100vw"');
    expect(withAll.hints).toEqual([]);

    const bare = photo();
    expect(bare.code).toContain('alt=""');
    expect(bare.hints.join(" ")).toMatch(/alt text is empty/);
  });

  it("an explicit empty alt is a deliberate decorative image: no hint", () => {
    expect(photo({}, { alt: "" }).hints).toEqual([]);
  });

  it("applies the placeholder as style, background image, or data attribute", () => {
    expect(photo().code).toContain('style="background-color:#d828c8"');
    const lqip = photo({ placeholder: { kind: "lqip", value: "data:image/webp;base64,AAAA" } });
    expect(lqip.code).toContain(
      'style="background-image:url(data:image/webp;base64,AAAA);background-size:cover"',
    );
    const hash = photo({ placeholder: { kind: "blurhash", value: "LEHV6nWB2yk8" } });
    expect(hash.code).toContain('data-blurhash="LEHV6nWB2yk8"');
    const none = photo({ placeholder: undefined });
    expect(none.code).not.toContain("style=");
  });

  it("leaves out outputs that were never written", () => {
    const entry = photoEntry();
    entry.outputs.push(
      image("img/photo/photo-1920.webp", "webp", 1920, 1234, { status: "already-optimal" }),
    );
    const { code } = build([{ "public/img/photo.jpg": entry }], "public/img/photo.jpg");
    expect(code).not.toContain("1920");
  });

  it("omits a format with no outputs, rather than emitting an empty <source>", () => {
    const entry = photoEntry();
    entry.outputs = entry.outputs.filter((o) => o.format === "webp");
    const { code } = build([{ "public/img/photo.jpg": entry }], "public/img/photo.jpg");
    expect(code).not.toContain("image/avif");
    expect(code).toContain("image/webp");
  });

  it("with no WebP, the <img> falls back to the original file and says so", () => {
    const entry = photoEntry();
    entry.outputs = entry.outputs.filter((o) => o.format === "avif");
    const snippet = build([{ "public/img/photo.jpg": entry }], "public/img/photo.jpg");
    expect(snippet.code).toContain('<img src="/img/photo.jpg"');
    expect(snippet.hints.join(" ")).toMatch(/falls back to the original/);
  });

  it("with nothing written, is a plain <img> of the original and says why", () => {
    const entry = photoEntry({ outputs: [] });
    const snippet = build([{ "public/img/photo.jpg": entry }], "public/img/photo.jpg");
    expect(snippet.code).not.toContain("<picture");
    expect(snippet.code).toMatch(/^<img src="\/img\/photo\.jpg"/);
    expect(snippet.hints.join(" ")).toMatch(/not smaller than the source/);
  });

  it("percent-encodes unsafe path characters in every URL", () => {
    const entry = photoEntry();
    for (const o of entry.outputs) o.url = o.url.replace("img/photo", "my img/a#b");
    const { code } = build([{ "public/img/photo.jpg": entry }], "public/img/photo.jpg");
    expect(code).toContain("/_bytecut/my%20img/a%23b/photo-640.avif 640w");
    expect(code).not.toContain("my img");
  });

  it("returns null for a file that is not in the manifest", () => {
    expect(buildSnippet(manifestWith(), target("public/nope.jpg"), { format: "html" })).toBeNull();
  });
});

describe("video snippets", () => {
  const vid = (preset: string, withAudio = false, opts: Partial<SnippetOptions> = {}) =>
    build([{}, { "public/v/clip.mp4": videoEntry(preset, withAudio) }], "public/v/clip.mp4", opts);

  it("tries AV1 first and gives each source its exact codecs, so a fallback can happen", () => {
    const { code } = vid("content-video");
    const av1 = code.indexOf("av01.0.05M.08");
    const h264 = code.indexOf("avc1.64001f");
    expect(av1).toBeGreaterThan(-1);
    expect(av1).toBeLessThan(h264);
    expect(code).toContain(`type='video/mp4; codecs="av01.0.05M.08"'`);
    expect(code).toContain(`type='video/mp4; codecs="avc1.64001f"'`);
  });

  it("includes the audio codec when the output has audio", () => {
    expect(vid("content-video", true).code).toContain(`codecs="av01.0.05M.08, mp4a.40.2"`);
  });

  it("a background video loops silently and has no controls", () => {
    const { code } = vid("background-video");
    for (const attr of ["autoplay", "muted", "loop", "playsinline"]) expect(code).toContain(attr);
    expect(code).not.toContain("controls");
    expect(code).toContain('preload="auto"');
  });

  it("a GIF replacement behaves like a background video", () => {
    const { code } = vid("gif-to-video");
    expect(code).toContain("autoplay muted loop playsinline");
    expect(code).not.toContain("controls");
  });

  it("content has controls and loads only metadata, and does not autoplay", () => {
    const { code } = vid("content-video", true);
    expect(code).toContain("controls");
    expect(code).toContain('preload="metadata"');
    expect(code).not.toContain("autoplay");
    expect(code).not.toContain("muted");
  });

  it("has the poster and the output dimensions", () => {
    const { code } = vid("content-video");
    expect(code).toContain('poster="/_bytecut/v/clip/clip-poster.avif"');
    expect(code).toContain('width="1280" height="720"');
  });

  it("derives a conservative AV1 codec string for an older manifest, never none", () => {
    const entry = videoEntry("content-video");
    for (const o of entry.outputs) delete o.codecs;
    const { code } = build([{}, { "public/v/clip.mp4": entry }], "public/v/clip.mp4");
    // Without it, a browser that cannot decode AV1 would still pick that <source>.
    expect(code).toContain(`codecs="av01.0.05M.08"`);
    expect(code).toContain('type="video/mp4"'); // H.264 plain
  });

  it("says so when there is nothing to embed", () => {
    const entry = videoEntry("content-video");
    entry.outputs = entry.outputs.filter((o) => o.role === "poster");
    const snippet = build([{}, { "public/v/clip.mp4": entry }], "public/v/clip.mp4");
    expect(snippet.hints.join(" ")).toMatch(/nothing to embed/);
  });

  it("applies the placeholder colour to the video element", () => {
    expect(vid("content-video").code).toContain('style="background-color:#0808f8"');
  });
});

describe("snippetFormatFor (format follows the framework)", () => {
  it.each([
    [{ framework: "next", react: true }, "jsx"],
    [{ framework: "next", react: false }, "jsx"],
    [{ framework: "vite", react: true }, "jsx"],
    [{ framework: "vite", react: false }, "html"],
    [{ framework: "astro", react: true }, "html"],
    [{ framework: "static", react: false }, "html"],
  ] as const)("%j → %s", (project, expected) => {
    expect(snippetFormatFor(project)).toBe(expected);
  });
});

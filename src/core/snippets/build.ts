import type {
  Manifest,
  ManifestOutput,
  ManifestSource,
  ManifestVideoOutput,
  ManifestVideoSource,
} from "../manifest/types.js";
import type { Placeholder } from "../placeholders/types.js";
import { fallbackAv1CodecString } from "../video/codecs.js";
import { render, type Attr, type El, type Syntax } from "./render.js";

export interface SnippetOptions {
  format: Syntax;
  alt?: string;
  sizes?: string;
  className?: string;
  /** Force `fetchpriority="high"` and no lazy loading (default: from the preset). */
  priority?: boolean;
  /** Force lazy loading even for a priority image. */
  lazy?: boolean;
  /** `<video>` attributes override: default depends on the preset. */
  controls?: boolean;
}

export interface Snippet {
  kind: "image" | "video";
  source: string;
  code: string;
  /** Things the user should look at, e.g. alt text left empty. Never part of `code`. */
  hints: string[];
}

export interface SnippetTarget {
  /** Project-relative source path as keyed in the manifest. */
  source: string;
  /** Served URL of the original, used only when no optimized fallback exists. */
  originalUrl: string;
}

/** Percent-encode each path segment (spaces, `#`, `?`), keeping the slashes. */
export function encodeUrl(url: string): string {
  return url
    .split("/")
    .map((segment) => (segment === "" ? segment : encodeURIComponent(decodeSafe(segment))))
    .join("/");
}

function decodeSafe(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const MIME: Record<string, string> = { avif: "image/avif", webp: "image/webp" };

const byWidth = (a: { width: number }, b: { width: number }) => a.width - b.width;

function placeholderAttrs(p: Placeholder | undefined): Attr[] {
  if (!p) return [];
  switch (p.kind) {
    case "dominant-color":
      return [{ name: "style", value: { style: { backgroundColor: p.value } } }];
    case "lqip":
      return [
        {
          name: "style",
          value: {
            style: {
              backgroundImage: `url(${p.value})`,
              backgroundSize: "cover",
            },
          },
        },
      ];
    case "blurhash":
      return [{ name: "data-blurhash", value: p.value }];
  }
}

export function imageElement(
  entry: ManifestSource,
  target: SnippetTarget,
  options: SnippetOptions,
): { el: El; hints: string[] } {
  const hints: string[] = [];
  const written = entry.outputs.filter((o) => o.status === "written");
  const ofFormat = (f: ManifestOutput["format"]): ManifestOutput[] =>
    written.filter((o) => o.format === f).sort(byWidth);

  const sources: El[] = [];
  for (const format of ["avif", "webp"] as const) {
    const outs = ofFormat(format);
    if (outs.length === 0) continue;
    sources.push({
      tag: "source",
      attrs: [
        { name: "type", value: MIME[format]! },
        {
          name: "srcset",
          value: outs.map((o) => `${encodeUrl(o.url)} ${o.width}w`).join(", "),
        },
        { name: "sizes", value: options.sizes ?? "100vw" },
      ],
    });
  }

  // The <img> is the universally supported file: JPEG (or PNG for transparency), else the
  // largest WebP, else the original.
  const compatible = ofFormat("jpg").length > 0 ? ofFormat("jpg") : ofFormat("png");
  const fallbackSet = compatible.length > 0 ? compatible : ofFormat("webp");
  const fallback = fallbackSet[fallbackSet.length - 1];
  if (!fallback) {
    hints.push(
      sources.length === 0
        ? "No optimized outputs were written (they were not smaller than the source), so this uses the original file."
        : "No JPEG, PNG or WebP output exists, so the <img> falls back to the original file.",
    );
  }

  const priority = options.priority ?? entry.priority === true;
  const lazy = options.lazy ?? !priority;
  const src = fallback ? encodeUrl(fallback.url) : encodeUrl(target.originalUrl);
  const width = fallback?.width ?? entry.width;
  const height = fallback?.height ?? entry.height;

  const img: Attr[] = [
    { name: "src", value: src },
    // Several JPEG/PNG widths and no <picture> to carry them: the <img> carries the set.
    ...(compatible.length > 1
      ? [
          {
            name: "srcset",
            value: compatible.map((o) => `${encodeUrl(o.url)} ${o.width}w`).join(", "),
          },
          { name: "sizes", value: options.sizes ?? "100vw" },
        ]
      : []),
    { name: "width", value: String(width) },
    { name: "height", value: String(height) },
    { name: "alt", value: options.alt ?? "" },
  ];
  if (options.className) img.push({ name: "class", value: options.className });
  if (priority) img.push({ name: "fetchpriority", value: "high" });
  if (lazy) img.push({ name: "loading", value: "lazy" });
  img.push({ name: "decoding", value: "async" });
  img.push(...placeholderAttrs(entry.placeholder));

  if (options.alt === undefined) {
    hints.push(
      'alt text is empty (marks the image decorative). Set it with --alt "…" if it carries meaning.',
    );
  }

  const imgEl: El = { tag: "img", attrs: img };
  // A <picture> with no <source> children is just an <img>.
  const el: El =
    sources.length === 0 ? imgEl : { tag: "picture", attrs: [], children: [...sources, imgEl] };
  return { el, hints };
}

const LOOPING = new Set(["background-video", "gif-to-video"]);

function videoType(out: ManifestVideoOutput): string {
  if (out.codecs) return `video/mp4; codecs="${out.codecs}"`;
  // Older manifests: AV1 needs a codec string or a browser that cannot decode it still picks it.
  if (out.codec === "av1")
    return `video/mp4; codecs="${fallbackAv1CodecString(out.width, out.height)}"`;
  return "video/mp4";
}

export function videoElement(
  entry: ManifestVideoSource,
  _target: SnippetTarget,
  options: SnippetOptions,
): { el: El; hints: string[] } {
  const hints: string[] = [];
  const videos = entry.outputs.filter((o) => o.role === "video" && o.status === "written");
  // AV1 first: a browser takes the first source it can play, and the fallback comes last.
  const order = { av1: 0, h264: 1 } as const;
  videos.sort((a, b) => (order[a.codec ?? "h264"] ?? 9) - (order[b.codec ?? "h264"] ?? 9));
  const poster = entry.outputs.find((o) => o.role === "poster" && o.status === "written");

  if (videos.length === 0) {
    hints.push("No video outputs were written, so there is nothing to embed.");
  }
  const main = videos[0];
  const looping = LOOPING.has(entry.preset);
  const controls = options.controls ?? !looping;

  const attrs: Attr[] = [];
  if (main) {
    attrs.push({ name: "width", value: String(main.width) });
    attrs.push({ name: "height", value: String(main.height) });
  }
  if (options.className) attrs.push({ name: "class", value: options.className });
  if (poster) attrs.push({ name: "poster", value: encodeUrl(poster.url) });
  if (looping) {
    attrs.push(
      { name: "autoplay", value: true },
      { name: "muted", value: true },
      { name: "loop", value: true },
      { name: "playsinline", value: true },
    );
  } else {
    attrs.push({ name: "playsinline", value: true });
  }
  if (controls) attrs.push({ name: "controls", value: true });
  attrs.push({ name: "preload", value: looping ? "auto" : "metadata" });
  attrs.push(...placeholderAttrs(entry.placeholder));

  const children: El[] = videos.map((o) => ({
    tag: "source",
    attrs: [
      { name: "src", value: encodeUrl(o.url) },
      { name: "type", value: videoType(o) },
    ],
  }));
  return { el: { tag: "video", attrs, children }, hints };
}

export type LookupResult =
  { kind: "image"; entry: ManifestSource } | { kind: "video"; entry: ManifestVideoSource } | null;

export function lookup(manifest: Manifest, source: string): LookupResult {
  const image = manifest.sources[source];
  if (image) return { kind: "image", entry: image };
  const video = manifest.videos[source];
  if (video) return { kind: "video", entry: video };
  return null;
}

export function buildSnippet(
  manifest: Manifest,
  target: SnippetTarget,
  options: SnippetOptions,
): Snippet | null {
  const found = lookup(manifest, target.source);
  if (!found) return null;
  const { el, hints } =
    found.kind === "image"
      ? imageElement(found.entry, target, options)
      : videoElement(found.entry, target, options);
  return { kind: found.kind, source: target.source, code: render(el, options.format), hints };
}

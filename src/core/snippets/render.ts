/**
 * A tiny element tree rendered to HTML or JSX. Building one tree and serialising it twice is
 * what keeps the two outputs from drifting apart (attribute order, which attributes exist).
 */

export type Syntax = "html" | "jsx";

export type AttrValue = string | true | { style: Record<string, string> };

export interface Attr {
  /** Canonical HTML name, e.g. `srcset`. JSX renames are applied at render time. */
  name: string;
  value: AttrValue;
}

export interface El {
  tag: string;
  attrs: Attr[];
  children?: El[];
}

/** Attribute names that JSX spells differently from HTML. */
const JSX_NAMES: Record<string, string> = {
  class: "className",
  srcset: "srcSet",
  fetchpriority: "fetchPriority",
  playsinline: "playsInline",
  autoplay: "autoPlay",
  crossorigin: "crossOrigin",
  decoding: "decoding",
  tabindex: "tabIndex",
};

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function escapeHtml(value: string, quote: '"' | "'"): string {
  let out = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  out = quote === '"' ? out.replace(/"/g, "&quot;") : out.replace(/'/g, "&#39;");
  return out;
}

function htmlValue(value: string): string {
  // Prefer double quotes; single quotes avoid escaping when the value itself contains them
  // (codec strings like `video/mp4; codecs="av01.0.08M.08"`).
  if (value.includes('"') && !value.includes("'")) return `'${escapeHtml(value, "'")}'`;
  return `"${escapeHtml(value, '"')}"`;
}

/** A JSX attribute value: a plain string when that is unambiguous, else an expression. */
function jsxValue(value: string): string {
  // JSX string attributes decode HTML entities and cannot contain their own quote or a
  // newline, so anything outside plain printable ASCII goes through an expression.
  const plain = /^[\x20-\x7e]*$/.test(value) && !/[\\{}&<>]/.test(value);
  if (plain && !value.includes('"')) return `"${value}"`;
  // Codec strings contain double quotes: a single-quoted attribute is valid JSX and clearer.
  if (plain && !value.includes("'")) return `'${value}'`;
  return `{${JSON.stringify(value)}}`;
}

function renderAttr(attr: Attr, syntax: Syntax): string {
  if (syntax === "html") {
    if (attr.value === true) return attr.name;
    if (typeof attr.value === "string") return `${attr.name}=${htmlValue(attr.value)}`;
    const css = Object.entries(attr.value.style)
      .map(([k, v]) => `${kebab(k)}:${v}`)
      .join(";");
    return `style=${htmlValue(css)}`;
  }
  const name = JSX_NAMES[attr.name] ?? attr.name;
  if (attr.value === true) return name;
  if (typeof attr.value === "string") return `${name}=${jsxValue(attr.value)}`;
  const body = Object.entries(attr.value.style)
    .map(([k, v]) => `${camel(k)}: ${JSON.stringify(v)}`)
    .join(", ");
  return `style={{ ${body} }}`;
}

/** Elements that never have children and, in HTML, no closing tag. */
const VOID = new Set(["source", "img"]);

export function render(el: El, syntax: Syntax, indent = ""): string {
  const attrs = el.attrs.map((a) => renderAttr(a, syntax));
  const open = [el.tag, ...attrs].join(" ");
  if (VOID.has(el.tag)) return `${indent}<${open}${syntax === "jsx" ? " /" : ""}>`;
  const children = el.children ?? [];
  if (children.length === 0) return `${indent}<${open}></${el.tag}>`;
  const inner = children.map((c) => render(c, syntax, `${indent}  `)).join("\n");
  return `${indent}<${open}>\n${inner}\n${indent}</${el.tag}>`;
}

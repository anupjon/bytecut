import { describe, expect, it } from "vitest";
import { render, type El } from "../../../src/core/snippets/render.js";
import { encodeUrl } from "../../../src/core/snippets/build.js";

const img = (...attrs: El["attrs"]): El => ({ tag: "img", attrs });

describe("render: HTML", () => {
  it("renders void elements without a closing slash and boolean attributes bare", () => {
    expect(render(img({ name: "src", value: "/a.jpg" }), "html")).toBe('<img src="/a.jpg">');
    const video: El = {
      tag: "video",
      attrs: [
        { name: "autoplay", value: true },
        { name: "muted", value: true },
      ],
      children: [{ tag: "source", attrs: [{ name: "src", value: "/v.mp4" }] }],
    };
    expect(render(video, "html")).toBe('<video autoplay muted>\n  <source src="/v.mp4">\n</video>');
  });

  it("escapes attribute values", () => {
    const out = render(img({ name: "alt", value: 'Tom & "Jerry" <3' }), "html");
    expect(out).toBe("<img alt='Tom &amp; \"Jerry\" &lt;3'>");
    // Both quote kinds present: falls back to double quotes with the inner ones escaped.
    expect(render(img({ name: "alt", value: `it's "x"` }), "html")).toBe(
      '<img alt="it\'s &quot;x&quot;">',
    );
  });

  it("uses single quotes for codec strings so they stay readable", () => {
    const out = render(
      { tag: "source", attrs: [{ name: "type", value: 'video/mp4; codecs="av01.0.08M.08"' }] },
      "html",
    );
    expect(out).toBe(`<source type='video/mp4; codecs="av01.0.08M.08"'>`);
  });

  it("renders style objects as kebab-case CSS", () => {
    const out = render(
      img({
        name: "style",
        value: { style: { backgroundColor: "#fff", backgroundSize: "cover" } },
      }),
      "html",
    );
    expect(out).toBe('<img style="background-color:#fff;background-size:cover">');
  });

  it("keeps class and srcset in their HTML spelling", () => {
    const out = render(
      img({ name: "class", value: "a" }, { name: "srcset", value: "x 1w" }),
      "html",
    );
    expect(out).toBe('<img class="a" srcset="x 1w">');
  });
});

describe("render: JSX", () => {
  it("self-closes void elements and renames attributes", () => {
    const out = render(
      img(
        { name: "class", value: "card" },
        { name: "srcset", value: "a 1w" },
        { name: "fetchpriority", value: "high" },
      ),
      "jsx",
    );
    expect(out).toBe('<img className="card" srcSet="a 1w" fetchPriority="high" />');
  });

  it("renames the video attributes React expects", () => {
    const out = render(
      {
        tag: "video",
        attrs: [
          { name: "autoplay", value: true },
          { name: "playsinline", value: true },
          { name: "muted", value: true },
          { name: "loop", value: true },
        ],
        children: [],
      },
      "jsx",
    );
    expect(out).toBe("<video autoPlay playsInline muted loop></video>");
  });

  it("renders style as an object with camelCase keys", () => {
    const out = render(
      img({ name: "style", value: { style: { backgroundColor: "#d828c8" } } }),
      "jsx",
    );
    expect(out).toBe('<img style={{ backgroundColor: "#d828c8" }} />');
  });

  it("uses single quotes for codec strings and an expression for anything unsafe", () => {
    expect(
      render(
        { tag: "source", attrs: [{ name: "type", value: 'video/mp4; codecs="avc1.64001f"' }] },
        "jsx",
      ),
    ).toBe(`<source type='video/mp4; codecs="avc1.64001f"' />`);
    // Both quote kinds, braces, ampersands and non-ASCII cannot sit in a JSX string attribute.
    expect(render(img({ name: "alt", value: `a "b" 'c'` }), "jsx")).toBe(
      `<img alt={${JSON.stringify(`a "b" 'c'`)}} />`,
    );
    expect(render(img({ name: "alt", value: "{x} & é" }), "jsx")).toBe(
      `<img alt={${JSON.stringify("{x} & é")}} />`,
    );
  });

  it("keeps data-* attributes as written", () => {
    expect(render(img({ name: "data-blurhash", value: "LEHV6n" }), "jsx")).toBe(
      '<img data-blurhash="LEHV6n" />',
    );
  });
});

describe("encodeUrl", () => {
  it("percent-encodes each segment and keeps the slashes", () => {
    expect(encodeUrl("/_bytecut/my media/a b#1?.avif")).toBe(
      "/_bytecut/my%20media/a%20b%231%3F.avif",
    );
    expect(encodeUrl("/plain/path.avif")).toBe("/plain/path.avif");
  });

  it("does not double-encode an already-encoded segment", () => {
    expect(encodeUrl("/a%20b/c.avif")).toBe("/a%20b/c.avif");
  });

  it("copes with a stray percent sign", () => {
    expect(encodeUrl("/100%/a.avif")).toBe("/100%25/a.avif");
  });
});

import { describe, expect, it } from "vitest";
import { parseManifest, serializeManifest } from "../../../src/core/manifest/io.js";
import type { Manifest } from "../../../src/core/manifest/types.js";

const sha = (c: string) => c.repeat(64);

export const sample: Manifest = {
  version: 3,
  tools: { sharp: "0.35.5", bytecut: "0.0.1" },
  publicPath: "/_bytecut",
  videos: {},
  sources: {
    "b/two.jpg": {
      sha256: sha("b"),
      bytes: 2000,
      width: 800,
      height: 600,
      preset: "photo",
      outputs: [
        {
          path: "b/two/two-640.avif",
          url: "/_bytecut/b/two/two-640.avif",
          format: "avif",
          width: 640,
          height: 480,
          bytes: 500,
          sha256: sha("c"),
          lossless: false,
          quality: 60,
          effort: 4,
          encoder: "libaom-av1 3.15.1",
          status: "written",
        },
      ],
    },
    "a/one.jpg": {
      sha256: sha("a"),
      bytes: 100,
      width: 10,
      height: 10,
      preset: "photo",
      outputs: [],
    },
  },
};

describe("manifest serialization", () => {
  it("round-trips", () => {
    expect(parseManifest(serializeManifest(sample))).toEqual(sample);
  });

  it("is byte-identical regardless of insertion order and ends with a newline", () => {
    const reordered: Manifest = {
      ...sample,
      tools: { bytecut: "0.0.1", sharp: "0.35.5" },
      sources: Object.fromEntries(Object.entries(sample.sources).reverse()),
    };
    const text = serializeManifest(sample);
    expect(serializeManifest(reordered)).toBe(text);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"a/one.jpg"')).toBeLessThan(text.indexOf('"b/two.jpg"'));
  });

  it("contains no timestamps", () => {
    expect(serializeManifest(sample)).not.toMatch(/\d{4}-\d{2}-\d{2}|"(created|updated|time)/i);
  });
});

describe("parseManifest", () => {
  it("rejects invalid JSON", () => {
    expect(() => parseManifest("{nope")).toThrowError(/not valid JSON/);
  });

  it("rejects a newer version with an upgrade hint", () => {
    try {
      parseManifest(JSON.stringify({ version: 4 }));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "MANIFEST_UNSUPPORTED" });
    }
  });

  it("rejects a version-1 manifest from the pre-release layout with a clear instruction", () => {
    try {
      parseManifest(JSON.stringify({ version: 1 }));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "MANIFEST_OUTDATED" });
      expect((error as Error).message).toMatch(/Delete the output folder/);
    }
  });

  it("reads a version-2 manifest and upgrades it in memory with no videos", () => {
    const { videos: _videos, ...v2 } = { ...sample, version: 2 as const };
    void _videos;
    const parsed = parseManifest(JSON.stringify(v2));
    expect(parsed.version).toBe(3);
    expect(parsed.videos).toEqual({});
    expect(parsed.sources).toEqual(sample.sources);
  });

  it("round-trips video entries", () => {
    const withVideo = {
      ...sample,
      videos: {
        "v/a.mp4": {
          sha256: "e".repeat(64),
          bytes: 5000,
          width: 1920,
          height: 1080,
          durationSec: 3,
          preset: "content-video",
          outputs: [
            {
              path: "v/a/a-1920.av1.mp4",
              url: "/_bytecut/v/a/a-1920.av1.mp4",
              role: "video" as const,
              format: "mp4" as const,
              codec: "av1" as const,
              width: 1920,
              height: 1080,
              fps: 30,
              bytes: 900,
              sha256: "f".repeat(64),
              crf: 32,
              speed: "6",
              maxWidth: null,
              maxFps: null,
              audio: "keep" as const,
              encoder: "libsvtav1 (ffmpeg 6.1.1)",
              status: "written" as const,
            },
          ],
        },
      },
    };
    expect(parseManifest(serializeManifest(withVideo))).toEqual(withVideo);
  });

  it("rejects a malformed manifest with a readable reason", () => {
    const bad = { ...sample, sources: { "a.jpg": { sha256: "short" } } };
    try {
      parseManifest(JSON.stringify(bad));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "MANIFEST_INVALID" });
      expect((error as Error).message).toMatch(/sources/);
    }
  });

  it("rejects unknown fields", () => {
    expect(() => parseManifest(JSON.stringify({ ...sample, extra: 1 }))).toThrow();
  });
});

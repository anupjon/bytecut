import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../src/core/config/schema.js";
import { parseSize } from "../../../src/core/units.js";

const errorOf = (raw: unknown): string => {
  try {
    parseConfig(raw, "bytecut.config.json");
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the config to be rejected");
};

describe("config schema", () => {
  it("accepts an empty object: zero-config", () => {
    expect(parseConfig({}, "c")).toEqual({});
  });

  it("accepts every documented field", () => {
    const config = parseConfig(
      {
        include: ["public"],
        exclude: ["public/raw/**"],
        outDir: "public/_bytecut",
        publicPath: "/_bytecut",
        framework: "next",
        assets: { "public/hero/**": "hero" },
        presets: { mine: { extends: "photo", target: "high", widths: [400, 800] } },
        audit: {
          rules: { "image/heavy": ["error", { maxBytes: 100000 }], "image/metadata": "off" },
          ignore: ["public/vendor/**"],
        },
        budgets: { maxFileSize: "250 KB", maxTotalSize: 5_000_000 },
        manifest: { placeholder: "blurhash" },
        concurrency: 3,
        ffmpegPath: "/usr/bin/ffmpeg",
        ffprobePath: "/usr/bin/ffprobe",
      },
      "c",
    );
    expect(config.budgets).toEqual({ maxFileSize: 256_000, maxTotalSize: 5_000_000 });
  });

  it("reports every problem at once, with the path to each", () => {
    const message = errorOf({ outDir: 3, concurrency: 99, manifest: { placeholder: "sepia" } });
    expect(message).toMatch(/^bytecut\.config\.json is not a valid bytecut config:/);
    expect(message).toMatch(/outDir: /);
    expect(message).toMatch(/concurrency: /);
    expect(message).toMatch(
      /manifest\.placeholder: must be one of "dominant-color", "lqip", "blurhash", "none"/,
    );
  });

  it("suggests the intended key for a typo", () => {
    expect(errorOf({ ouDir: "x" })).toMatch(/unknown key "ouDir" \(did you mean "outDir"\?\)/);
    expect(errorOf({ budgets: { maxFileSzie: 1 } })).toMatch(/did you mean "maxFileSize"/);
    expect(errorOf({ presets: { a: { extends: "photo", widht: [1] } } })).toMatch(
      /did you mean "widths"/,
    );
  });

  it("does not guess when nothing is close", () => {
    expect(errorOf({ zzzzzzzz: 1 })).not.toMatch(/did you mean/);
  });

  it("validates rule ids and says which one is unknown", () => {
    expect(errorOf({ audit: { rules: { "image/heavvy": "warn" } } })).toMatch(
      /audit\.rules\.image\/heavvy: unknown rule \(did you mean "image\/heavy"\?\)/,
    );
  });

  it("rejects bad severities and sizes readably", () => {
    expect(errorOf({ audit: { rules: { "image/heavy": "fatal" } } })).toMatch(/audit\.rules/);
    expect(errorOf({ budgets: { maxFileSize: "lots" } })).toMatch(
      /budgets\.maxFileSize: "lots" is not a size/,
    );
  });

  it("rejects perceptual-search fields until they have an engine, and says so", () => {
    for (const field of ["ssimulacra2", "vmaf", "raw"]) {
      const message = errorOf({ presets: { a: { extends: "photo", [field]: 70 } } });
      expect(message).toMatch(new RegExp(`presets\\.a\\.${field}: .*M9`));
    }
    expect(() => parseConfig({ ssimulacra2Path: "/bin/ssimulacra2" }, "c")).not.toThrow();
  });

  it("requires publicPath to look like a URL prefix", () => {
    expect(errorOf({ publicPath: "assets" })).toMatch(/publicPath: must start with "\/"/);
    expect(() => parseConfig({ publicPath: "https://cdn.example.com/a" }, "c")).not.toThrow();
  });
});

describe("parseSize", () => {
  it.each([
    ["250 KB", 256_000],
    ["1.5mb", 1_572_864],
    ["1024", 1024],
    ["2 GiB", 2 * 1024 ** 3],
    ["0 B", 0],
  ])("%s → %d", (text, bytes) => {
    expect(parseSize(text)).toBe(bytes);
  });
  it.each(["", "KB", "12 parsecs", "-5 KB", "1e3"])("rejects %j", (text) => {
    expect(parseSize(text)).toBeNull();
  });
});

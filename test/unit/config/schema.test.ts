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

  it("accepts a native scorer path", () => {
    expect(() => parseConfig({ ssimulacra2Path: "/bin/ssimulacra2" }, "c")).not.toThrow();
  });

  describe("perceptual search fields", () => {
    const preset = (fields: Record<string, unknown>) => ({
      presets: { a: { extends: "photo", ...fields } },
    });

    it("accepts a target, and a size cap with its floor", () => {
      expect(() => parseConfig(preset({ ssimulacra2: 80 }), "c")).not.toThrow();
      const config = parseConfig(preset({ ssimulacra2: 80, floor: 60, maxSize: "150 KB" }), "c");
      expect(config.presets!.a).toMatchObject({ ssimulacra2: 80, floor: 60, maxSize: 153_600 });
    });

    it("explains what each missing or inconsistent field needs", () => {
      expect(errorOf(preset({ maxSize: "10 KB" }))).toMatch(
        /presets\.a\.maxSize: needs `ssimulacra2`/,
      );
      expect(errorOf(preset({ ssimulacra2: 80, maxSize: "10 KB" }))).toMatch(
        /presets\.a\.floor: is required with `maxSize`/,
      );
      expect(errorOf(preset({ floor: 60 }))).toMatch(/presets\.a\.floor: needs `ssimulacra2`/);
      expect(errorOf(preset({ ssimulacra2: 80, floor: 60 }))).toMatch(
        /presets\.a\.floor: only applies with `maxSize`/,
      );
      expect(errorOf(preset({ ssimulacra2: 60, floor: 80, maxSize: "10 KB" }))).toMatch(
        /presets\.a\.floor: must not exceed `ssimulacra2` \(60\)/,
      );
    });

    it("bounds the target to the metric's range", () => {
      expect(errorOf(preset({ ssimulacra2: 0 }))).toMatch(/presets\.a\.ssimulacra2/);
      expect(errorOf(preset({ ssimulacra2: 101 }))).toMatch(/presets\.a\.ssimulacra2/);
    });

    it("accepts vmaf, bounded to its range, and not together with ssimulacra2", () => {
      expect(() => parseConfig(preset({ vmaf: 90 }), "c")).not.toThrow();
      expect(errorOf(preset({ vmaf: 0 }))).toMatch(/presets\.a\.vmaf/);
      expect(errorOf(preset({ vmaf: 101 }))).toMatch(/presets\.a\.vmaf/);
      expect(errorOf(preset({ vmaf: 90, ssimulacra2: 80 }))).toMatch(
        /presets\.a\.vmaf: cannot be combined with `ssimulacra2`/,
      );
      // A size cap holds a score: vmaf serves a video's, and the floor must stay below it.
      expect(() =>
        parseConfig(preset({ vmaf: 90, maxSize: "10 MB", floor: 60 }), "c"),
      ).not.toThrow();
      expect(errorOf(preset({ vmaf: 90, maxSize: "10 MB" }))).toMatch(
        /presets\.a\.floor: is required/,
      );
      expect(errorOf(preset({ vmaf: 90, maxSize: "10 MB", floor: 95 }))).toMatch(
        /presets\.a\.floor: must not exceed `vmaf` \(90\)/,
      );
      expect(errorOf(preset({ maxSize: "10 MB", floor: 60 }))).toMatch(
        /presets\.a\.(maxSize|floor): needs `ssimulacra2`/,
      );
    });

    it("still rejects raw, with the reason", () => {
      expect(errorOf(preset({ raw: "x" }))).toMatch(/presets\.a\.raw: `raw` is not supported/);
    });
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

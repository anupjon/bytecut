import { describe, expect, it } from "vitest";
import { resolveConfigData } from "../../../src/core/config/resolve.js";
import type { ProjectInfo } from "../../../src/core/scan/detect.js";
import { BUILTIN_CATALOG } from "../../../src/core/presets/catalog.js";

const project: ProjectInfo = {
  framework: "next",
  react: true,
  include: ["public"],
  outDir: "public/_bytecut",
  publicPath: "/_bytecut",
  staticRoot: "public",
};

describe("resolveConfigData", () => {
  it("an empty config resolves exactly like no config: nothing changes", () => {
    const resolved = resolveConfigData({}, project, null);
    expect(resolved.project).toEqual(project);
    expect(resolved.exclude).toEqual([]);
    expect(resolved.assets).toEqual([]);
    expect(resolved.rules).toEqual({});
    expect(resolved.budgets).toEqual({});
    expect(resolved.placeholder).toBeUndefined();
    expect(resolved.concurrency).toBeUndefined();
    expect(resolved.catalog.image).toEqual(BUILTIN_CATALOG.image);
    expect(resolved.policy.assetFor("public/img/a.jpg")).toBeUndefined();
    expect(resolved.provenance).toEqual({
      framework: "detected",
      include: "detected",
      outDir: "detected",
      publicPath: "detected",
    });
  });

  it("config values replace detected ones and say so", () => {
    const resolved = resolveConfigData(
      { include: ["assets"], outDir: "build/img", publicPath: "https://cdn.test/x" },
      project,
      null,
    );
    expect(resolved.project).toMatchObject({
      include: ["assets"],
      outDir: "build/img",
      publicPath: "https://cdn.test/x",
      // Not configurable: follows the framework.
      staticRoot: "public",
    });
    expect(resolved.provenance).toMatchObject({
      outDir: "config",
      include: "config",
      publicPath: "config",
    });
  });

  it("assets: first match wins, in the order written", () => {
    const { policy } = resolveConfigData(
      {
        assets: {
          "public/hero/*.jpg": "hero",
          "public/**/*.jpg": "icon",
          "*.png": "photo",
        },
      },
      project,
      null,
    );
    expect(policy.assetFor("public/hero/a.jpg")).toEqual({
      pattern: "public/hero/*.jpg",
      preset: "hero",
    });
    expect(policy.assetFor("public/img/b.jpg")).toEqual({
      pattern: "public/**/*.jpg",
      preset: "icon",
    });
    expect(policy.assetFor("public/img/c.png")).toEqual({ pattern: "*.png", preset: "photo" });
    expect(policy.assetFor("public/img/d.webp")).toBeUndefined();
  });

  it("an assets rule may name a preset defined in the same config", () => {
    const { policy, catalog } = resolveConfigData(
      {
        presets: { thumbs: { extends: "photo", widths: [200] } },
        assets: { "thumbs/**": "thumbs" },
      },
      project,
      null,
    );
    expect(policy.assetFor("thumbs/a.jpg")!.preset).toBe("thumbs");
    expect(catalog.image.thumbs!.widths).toEqual([200]);
  });

  it("rejects an assets rule naming an unknown preset, with a hint and the known names", () => {
    expect(() => resolveConfigData({ assets: { "a/**": "hreo" } }, project, null)).toThrow(
      /assets\["a\/\*\*"\]: unknown preset "hreo" \(did you mean "hero"\?\)\. Known presets: photo, hero, icon/,
    );
  });

  it("maps budgets to bytes and rule settings through unchanged", () => {
    const resolved = resolveConfigData(
      {
        budgets: { maxFileSize: 100_000, maxTotalSize: 2_000_000 },
        audit: {
          rules: { "image/heavy": ["error", { maxBytes: 5 }], "image/metadata": "off" },
          ignore: ["vendor/**"],
        },
        manifest: { placeholder: "lqip" },
        concurrency: 3,
        ffmpegPath: "/opt/ffmpeg",
      },
      project,
      null,
    );
    expect(resolved.budgets).toEqual({ maxFileBytes: 100_000, maxTotalBytes: 2_000_000 });
    expect(resolved.rules).toEqual({
      "image/heavy": ["error", { maxBytes: 5 }],
      "image/metadata": "off",
    });
    expect(resolved.auditIgnore).toEqual(["vendor/**"]);
    expect(resolved.placeholder).toBe("lqip");
    expect(resolved.concurrency).toBe(3);
    expect(resolved.ffmpegPath).toBe("/opt/ffmpeg");
  });
});

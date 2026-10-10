import { describe, expect, it } from "vitest";
import { escapeGlob, isLiteral, matchesGlob } from "../../../src/core/config/glob.js";

describe("matchesGlob", () => {
  it.each([
    ["public/img/hero.jpg", "public/img/hero.jpg", true],
    ["public/img/*.jpg", "public/img/a.jpg", true],
    ["public/img/*.jpg", "public/img/sub/a.jpg", false],
    ["public/**/*.jpg", "public/img/sub/a.jpg", true],
    ["public/**/*.jpg", "public/a.jpg", true],
    ["public/**", "public/img/a.png", true],
    ["**/hero.*", "public/img/hero.webp", true],
    ["img/?.png", "img/a.png", true],
    ["img/?.png", "img/ab.png", false],
    ["*.{mp4,mov}", "public/video/clip.mov", true],
    ["*.{mp4,mov}", "public/video/clip.webm", false],
    ["img/[ab].png", "img/b.png", true],
    ["img/[!ab].png", "img/b.png", false],
    ["img/[!ab].png", "img/c.png", true],
  ])("%s vs %s → %s", (pattern, path, expected) => {
    expect(matchesGlob(pattern, path)).toBe(expected);
  });

  it("matches a pattern without a slash at any depth, like .gitignore", () => {
    expect(matchesGlob("*.mp4", "a.mp4")).toBe(true);
    expect(matchesGlob("*.mp4", "public/video/deep/a.mp4")).toBe(true);
    expect(matchesGlob("hero.jpg", "public/hero.jpg")).toBe(true);
    // With a slash it is anchored to the project root.
    expect(matchesGlob("img/*.jpg", "public/img/a.jpg")).toBe(false);
  });

  it("is case sensitive and treats regex characters literally", () => {
    expect(matchesGlob("img/A.jpg", "img/a.jpg")).toBe(false);
    expect(matchesGlob("img/a+b (1).jpg", "img/a+b (1).jpg")).toBe(true);
    expect(matchesGlob("img/a.b.jpg", "img/aXb.jpg")).toBe(false);
  });

  it("treats unbalanced braces as ordinary characters", () => {
    expect(matchesGlob("img/{a.jpg", "img/{a.jpg")).toBe(true);
    expect(matchesGlob("img/a}.jpg", "img/a}.jpg")).toBe(true);
  });

  it("round-trips any file name through escapeGlob", () => {
    for (const name of [
      "img/a[1].jpg",
      "img/{x,y}.png",
      "img/*star*.jpg",
      "img/what?.jpg",
      "a\\b.jpg",
    ]) {
      expect(matchesGlob(escapeGlob(name), name)).toBe(true);
      expect(isLiteral(escapeGlob(name))).toBe(true);
    }
    expect(matchesGlob(escapeGlob("img/a[1].jpg"), "img/a1.jpg")).toBe(false);
  });

  it("knows which patterns are literal", () => {
    expect(isLiteral("public/img/hero.jpg")).toBe(true);
    expect(isLiteral("public/img/*.jpg")).toBe(false);
    expect(isLiteral("public/img/\\*.jpg")).toBe(true);
  });
});

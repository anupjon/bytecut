import { describe, expect, it } from "vitest";
import { svgoEngine } from "../../../src/core/engines/svg.js";

const PLAIN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>';

describe("svgoEngine.analyze", () => {
  it("measures how much svgo removes", () => {
    const messy = `<?xml version="1.0"?>\n<!-- a long editor comment ${"x".repeat(200)} -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n  <g>\n    <rect x="0" y="0" width="10" height="10" fill="#ff0000"/>\n  </g>\n</svg>\n`;
    const a = svgoEngine.analyze(messy);
    expect(a.minifiedBytes).not.toBeNull();
    expect(a.minifiedBytes!).toBeLessThan(Buffer.byteLength(messy) / 2);
    expect(a.embeddedRasterCount).toBe(0);
  });

  it("does not claim savings for an already-minimal file", () => {
    const a = svgoEngine.analyze(PLAIN);
    expect(a.minifiedBytes!).toBeLessThanOrEqual(Buffer.byteLength(PLAIN));
  });

  it("counts embedded base64 rasters and their size", () => {
    const b64 = "A".repeat(400);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${b64}"/><image href="data:image/jpeg;base64,${b64}"/><image href="other.png"/></svg>`;
    const a = svgoEngine.analyze(svg);
    expect(a.embeddedRasterCount).toBe(2);
    expect(a.embeddedRasterBytes).toBe(800);
  });

  it("does not count an embedded SVG or font as a raster", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,${"B".repeat(50)}"/></svg>`;
    expect(svgoEngine.analyze(svg).embeddedRasterCount).toBe(0);
  });

  it("reports null minified size for malformed input instead of throwing", () => {
    const a = svgoEngine.analyze("<svg><unclosed></svg");
    expect(a.minifiedBytes).toBeNull();
  });

  it("reports its version for cache fingerprinting", () => {
    expect(svgoEngine.version()).toMatch(/^svgo \d+\./);
  });
});

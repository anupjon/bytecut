import { describe, expect, it } from "vitest";
import { formatPlan } from "../../src/cli/format.js";
import { classify } from "../../src/core/classify/classify.js";
import type { ImageAnalysis, ImageEngine } from "../../src/core/engines/types.js";
import { buildPlan } from "../../src/core/plan/build.js";
import { serializePlan } from "../../src/core/plan/schema.js";
import { getImagePreset } from "../../src/core/presets/index.js";
import { fakeAnalysis } from "../helpers.js";

/**
 * Golden snapshots use a fake engine and hand-written byte buffers rather than real
 * images: sharp's JPEG/PNG bytes can differ across libjpeg/libvips versions, which would
 * make a golden built on them fail across the OS matrix. Update intentionally with `-u`.
 */
const probes: Record<string, Partial<ImageAnalysis>> = {
  "public/img/hero.jpg": { width: 2400, height: 1200 },
  "public/img/logo.png": {
    width: 300,
    height: 300,
    format: "png",
    hasAlpha: true,
    alphaUsed: true,
    colorCount: 6,
  },
  "public/img/mid.jpg": { width: 1000, height: 700 },
  "public/img/spinner.webp": { width: 64, height: 64, format: "webp", animated: true },
};

const engine: ImageEngine = {
  async analyze(input) {
    const p = probes[input.toString()];
    if (!p) throw new Error("corrupt");
    return fakeAnalysis({ width: 100, height: 100, ...p });
  },
  async encode() {
    throw new Error("planning only");
  },
  encoders: () => ({ avif: "fake", webp: "fake" }),
  versions: () => ({}),
};

async function plan() {
  return buildPlan({
    // Deliberately unsorted: the plan must come out sorted.
    files: [
      "/p/public/img/spinner.webp",
      "/p/public/img/hero.jpg",
      "/p/public/img/mid.jpg",
      "/p/public/img/logo.png",
    ],
    projectRoot: "/p",
    outDir: "/p/public/_bytecut",
    staticRoot: "public",
    choosePreset: (source, analysis) => {
      const v = classify(source, analysis);
      return { preset: getImagePreset(v.preset), reason: v.reason, confidence: v.confidence };
    },
    engine,
    readSource: async (path) => Buffer.from(path.replace("/p/", "")),
  });
}

describe("dry-run plan (golden)", () => {
  it("JSON", async () => {
    await expect(serializePlan(await plan())).toMatchFileSnapshot("./dry-run-plan.json");
  });

  it("text", async () => {
    await expect(`${formatPlan(await plan())}\n`).toMatchFileSnapshot("./dry-run-plan.txt");
  });

  it("is identical across repeated builds", async () => {
    expect(serializePlan(await plan())).toBe(serializePlan(await plan()));
  });
});

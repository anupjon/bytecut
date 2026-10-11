import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeAuditProject, makeImageFixtures } from "../../scripts/make-fixtures.js";
import { estimateItem, TRIAL_MAX_WIDTH } from "../../src/core/audit/estimate.js";
import { AnalysisCache } from "../../src/core/cache/store.js";
import { classify } from "../../src/core/classify/classify.js";
import { sharpImageEngine as engine } from "../../src/core/engines/image.js";
import { sha256 } from "../../src/core/hash.js";
import { buildPlan } from "../../src/core/plan/build.js";
import { buildCatalog } from "../../src/core/config/presets.js";
import { getImagePreset } from "../../src/core/presets/index.js";

// JPEG (the default) and the opt-in formats, so every encoder's estimate is held to ±25%.
const catalog = buildCatalog({
  photo: { formats: ["jpg", "avif", "webp"] },
  hero: { formats: ["jpg", "avif", "webp"] },
  icon: { formats: ["png", "avif", "webp"] },
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bytecut-estimator-"));
  await makeImageFixtures(join(dir, "images"));
  await makeAuditProject(join(dir, "project"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("size estimator (§M3: within ±25% of actual)", () => {
  it("is within 25% of the real encode at the largest planned width", async () => {
    const files = [
      ...(await readdir(join(dir, "images"))).map((f) => join(dir, "images", f)),
      ...[
        "hero.jpg",
        "photo-big.jpg",
        "diagram.png",
        "legacy.webp",
        "with-meta.jpg",
        "cmyk.jpg",
      ].map((f) => join(dir, "project/public/img", f)),
    ];
    const plan = await buildPlan({
      files,
      projectRoot: dir,
      outDir: join(dir, "out"),
      choosePreset: (source, a) => {
        const v = classify(source, a);
        return { preset: getImagePreset(v.preset, catalog), reason: v.reason };
      },
      engine,
      readSource: (p) => readFile(p),
    });

    const cache = AnalysisCache.empty("test");
    const rows: Array<{
      source: string;
      format: string;
      est: number;
      actual: number;
      err: number;
      extrapolated: boolean;
    }> = [];
    for (const item of plan.items) {
      if (item.skip) continue;
      const data = await readFile(join(dir, ...item.source.split("/")));
      expect(sha256(data)).toBe(item.sourceSha256);
      const est = await estimateItem(item, async () => data, { engine, cache });
      for (const f of est!.perFormat) {
        const planned = item.outputs.find((o) => o.format === f.format && o.width === f.width)!;
        const actual = (await engine.encode(data, planned)).data.byteLength;
        rows.push({
          source: item.source,
          format: f.format,
          est: f.bytes,
          actual,
          err: (f.bytes - actual) / actual,
          extrapolated: f.basis === "extrapolated",
        });
      }
    }

    const extrapolated = rows.filter((r) => r.extrapolated);
    // Guard against a vacuous pass: we must really be testing extrapolation.
    expect(extrapolated.length).toBeGreaterThanOrEqual(8);
    expect(extrapolated.every((r) => r.est > 0)).toBe(true);
    const worst = Math.max(...rows.map((r) => Math.abs(r.err)));
    console.info(
      `estimator: ${rows.length} outputs (${extrapolated.length} extrapolated), worst error ${(worst * 100).toFixed(1)}%\n` +
        extrapolated
          .map(
            (r) =>
              `  ${r.source} ${r.format}: ${r.est} vs ${r.actual} (${(r.err * 100).toFixed(1)}%)`,
          )
          .join("\n"),
    );
    for (const r of rows) {
      expect(
        Math.abs(r.err),
        `${r.source} ${r.format}: est ${r.est} vs actual ${r.actual}`,
      ).toBeLessThanOrEqual(0.25);
    }
  }, 120_000);

  it("is exact (basis 'exact') whenever the largest width fits the trial", async () => {
    const data = await readFile(join(dir, "images/small.jpg"));
    const plan = await buildPlan({
      files: [join(dir, "images/small.jpg")],
      projectRoot: dir,
      outDir: join(dir, "out"),
      choosePreset: () => ({ preset: getImagePreset("photo"), reason: "t" }),
      engine,
      readSource: async () => data,
    });
    const item = plan.items[0]!;
    expect(Math.max(...item.outputs.map((o) => o.width))).toBeLessThanOrEqual(TRIAL_MAX_WIDTH);
    const est = await estimateItem(item, async () => data, {
      engine,
      cache: AnalysisCache.empty("t"),
    });
    expect(est!.perFormat.every((f) => f.basis === "exact")).toBe(true);
    for (const f of est!.perFormat) {
      const planned = item.outputs.find((o) => o.format === f.format)!;
      expect(f.bytes).toBe((await engine.encode(data, planned)).data.byteLength);
    }
  });

  it("returns null for skipped items and encodes lazily, once, via the cache", async () => {
    const data = await readFile(join(dir, "images/small.jpg"));
    const plan = await buildPlan({
      files: [join(dir, "images/small.jpg")],
      projectRoot: dir,
      outDir: join(dir, "out"),
      choosePreset: () => ({ preset: getImagePreset("photo"), reason: "t" }),
      engine,
      readSource: async () => data,
    });
    const item = plan.items[0]!;
    expect(
      await estimateItem({ ...item, skip: { reason: "x" } }, async () => data, {
        engine,
        cache: AnalysisCache.empty("t"),
      }),
    ).toBeNull();

    const cache = AnalysisCache.empty("t");
    let reads = 0;
    const read = async () => {
      reads++;
      return data;
    };
    await estimateItem(item, read, { engine, cache });
    const first = reads;
    await estimateItem(item, read, { engine, cache });
    expect(first).toBeGreaterThan(0);
    expect(reads).toBe(first); // second pass was served entirely from the cache
  });
});

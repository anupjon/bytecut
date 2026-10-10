import { describe, expect, it } from "vitest";
import { checkCache } from "../../../src/core/manifest/cache.js";
import type { ManifestOutput, ManifestSource } from "../../../src/core/manifest/types.js";
import type { PlanItem } from "../../../src/core/plan/types.js";

const H = "a".repeat(64);
const OUT_HASH = "b".repeat(64);

const item: PlanItem = {
  source: "a.jpg",
  sourceBytes: 1000,
  sourceSha256: H,
  sourceWidth: 800,
  sourceHeight: 600,
  preset: "photo",
  outputs: [
    { path: "a/a-640.avif", format: "avif", width: 640, lossless: false, quality: 60, effort: 4 },
    { path: "a/a-640.webp", format: "webp", width: 640, lossless: false, quality: 78, effort: 4 },
  ],
};

const recorded = (o: Partial<ManifestOutput> & { path: string }): ManifestOutput => ({
  url: `/_bytecut/${o.path}`,
  format: "avif",
  width: 640,
  height: 480,
  bytes: 10,
  sha256: OUT_HASH,
  lossless: false,
  quality: 60,
  effort: 4,
  encoder: "e",
  status: "written",
  ...o,
});

const entry = (over: Partial<ManifestSource> = {}): ManifestSource => ({
  sha256: H,
  bytes: 1000,
  width: 800,
  height: 600,
  preset: "photo",
  outputs: [
    recorded({ path: "a/a-640.avif" }),
    recorded({ path: "a/a-640.webp", format: "webp", quality: 78 }),
  ],
  ...over,
});

const present = async () => OUT_HASH;

describe("checkCache", () => {
  it("hits when source, params and outputs all match", async () => {
    expect(await checkCache(item, entry(), present)).toEqual({ kind: "hit" });
  });

  it("misses for a source with no entry", async () => {
    expect(await checkCache(item, undefined, present)).toEqual({ kind: "miss", reason: "new" });
  });

  it("misses when the source hash changed", async () => {
    expect(await checkCache(item, entry({ sha256: "c".repeat(64) }), present)).toEqual({
      kind: "miss",
      reason: "source-changed",
    });
  });

  it("misses when a planned parameter changed", async () => {
    const changed = {
      ...item,
      outputs: [{ ...item.outputs[0]!, quality: 50 }, item.outputs[1]!],
    };
    expect(await checkCache(changed, entry(), present)).toEqual({
      kind: "miss",
      reason: "outputs-differ",
    });
  });

  it("misses when a planned output is not recorded", async () => {
    const more = {
      ...item,
      outputs: [...item.outputs, { ...item.outputs[0]!, path: "a/a-1280.avif", width: 1280 }],
    };
    expect(await checkCache(more, entry(), present)).toMatchObject({ reason: "outputs-differ" });
  });

  it("still hits when the manifest has extra (orphaned) outputs", async () => {
    const extra = entry();
    extra.outputs.push(recorded({ path: "a/a-300.avif", width: 300 }));
    expect(await checkCache(item, extra, present)).toEqual({ kind: "hit" });
  });

  it("misses when an output file is missing or modified", async () => {
    expect(await checkCache(item, entry(), async () => null)).toEqual({
      kind: "miss",
      reason: "output-missing",
    });
    expect(await checkCache(item, entry(), async () => "c".repeat(64))).toEqual({
      kind: "miss",
      reason: "output-modified",
    });
  });

  it("misses on a stale output", async () => {
    const stale = entry();
    stale.outputs[0] = { ...stale.outputs[0]!, status: "stale" };
    expect(await checkCache(item, stale, present)).toMatchObject({ reason: "output-stale" });
  });

  it("does not require a file for an already-optimal output", async () => {
    const e = entry();
    e.outputs[1] = recorded({ path: "a/a-640.webp", format: "webp", quality: 78 });
    delete e.outputs[1]!.sha256;
    e.outputs[1]!.status = "already-optimal";
    const lookups: string[] = [];
    const state = await checkCache(item, e, async (p) => {
      lookups.push(p);
      return OUT_HASH;
    });
    expect(state).toEqual({ kind: "hit" });
    expect(lookups).toEqual(["a/a-640.avif"]);
  });
});

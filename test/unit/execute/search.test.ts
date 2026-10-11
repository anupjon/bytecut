import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { orphanedOutput } from "../../../src/core/audit/rules/orphaned-output.js";
import type { EncodeResult, ImageEngine, RawImage } from "../../../src/core/engines/types.js";
import { runPlan } from "../../../src/core/execute/run.js";
import { SafeFs } from "../../../src/core/fs-safe.js";
import { sha256 } from "../../../src/core/hash.js";
import { checkCache } from "../../../src/core/manifest/cache.js";
import { updateManifest } from "../../../src/core/manifest/update.js";
import type { Plan, PlanItem, PlannedOutput } from "../../../src/core/plan/types.js";
import type { QualityScorer } from "../../../src/core/quality/types.js";
import { listFiles, tempDir } from "../../helpers.js";

const SOURCE_BYTES = 500_000;

/** Quality q scores 30 + 0.7q; a full encode is (w/1000)^2 * 400 * q bytes. */
function engine(counter: { full: number; crop: number }): ImageEngine {
  const header = (q: number, w: number, h: number, size: number) => {
    const b = Buffer.alloc(Math.max(size, 8));
    b[0] = 0xee;
    b[1] = q;
    b.writeUInt16LE(w, 2);
    b.writeUInt16LE(h, 4);
    return b;
  };
  return {
    async analyze() {
      throw new Error("not used");
    },
    encoders: () => ({ avif: "fake-avif", webp: "fake-webp" }),
    versions: () => ({}),
    async encode(_input, r): Promise<EncodeResult> {
      counter.full++;
      const h = Math.round(r.width * 0.75);
      return {
        data: header(r.quality, r.width, h, Math.round((r.width / 1000) ** 2 * 400 * r.quality)),
        width: r.width,
        height: h,
        encoder: "fake-encoder 1",
      };
    },
    async decodeRaw(input, options): Promise<RawImage> {
      if (input[0] === 0xee) {
        const w = input.readUInt16LE(2);
        const h = input.readUInt16LE(4);
        const data = new Uint8Array(w * h * 4).fill(255);
        data[0] = input[1]!;
        return { data, width: w, height: h, channels: 4 };
      }
      const w = Math.min(options.width ?? 2000, 2000);
      const h = Math.round(w * 0.75);
      return { data: new Uint8Array(w * h * 4).fill(255), width: w, height: h, channels: 4 };
    },
    async encodeRaw(image, r): Promise<EncodeResult> {
      counter.crop++;
      return {
        data: header(r.quality, image.width, image.height, r.quality * 10),
        width: image.width,
        height: image.height,
        encoder: "fake-encoder 1",
      };
    },
  };
}

const scorer: QualityScorer = {
  kind: "wasm",
  label: "fake",
  async score(_a, b) {
    return 30 + 0.7 * b.data[0]!;
  },
  async close() {},
};

const out = (path: string, width: number, extra: Partial<PlannedOutput> = {}): PlannedOutput => ({
  path,
  format: "avif",
  width,
  lossless: false,
  quality: 60,
  effort: 4,
  ...extra,
});

const search = { metric: "ssimulacra2" as const, target: 79 };

function itemWith(outputs: PlannedOutput[]): PlanItem {
  return {
    source: "assets/a.jpg",
    sourceBytes: SOURCE_BYTES,
    sourceSha256: sha256(Buffer.alloc(SOURCE_BYTES, 1)),
    sourceWidth: 2000,
    sourceHeight: 1500,
    preset: "photo",
    outputs,
  };
}

async function setup(item: PlanItem) {
  const root = await tempDir();
  await mkdir(join(root, "assets"));
  await writeFile(join(root, item.source), Buffer.alloc(item.sourceBytes, 1));
  const outDir = join(root, "out");
  const fs = await SafeFs.create({
    projectRoot: root,
    outDir,
    sourceFiles: [join(root, item.source)],
    sourceDirs: [],
  });
  return { root, outDir, fs };
}

const planOf = (item: PlanItem): Plan => ({
  version: 1,
  outDir: "out",
  publicPath: "/_bytecut",
  items: [item],
});

describe("executor with a quality search", () => {
  it("writes the searched quality and records how it was found", async () => {
    const item = itemWith([out("a-1280.avif", 1280, { search })]);
    const { root, outDir, fs } = await setup(item);
    const counter = { full: 0, crop: 0 };
    const result = await runPlan(planOf(item), {
      projectRoot: root,
      manifest: null,
      engine: engine(counter),
      fs,
      quality: { scorer: async () => scorer },
    });
    const o = result.items[0]!.outputs[0]!;
    expect(o).toMatchObject({
      status: "written",
      quality: 70,
      score: 79,
      scorer: "wasm",
      search: { metric: "ssimulacra2", target: 79 },
    });
    expect(await listFiles(outDir)).toEqual(["a-1280.avif"]);

    const manifest = updateManifest(null, planOf(item), result, {});
    expect(manifest.sources["assets/a.jpg"]!.outputs[0]).toMatchObject({
      quality: 70,
      score: 79,
      scorer: "wasm",
      search: { metric: "ssimulacra2", target: 79 },
    });
  });

  it("is a cache hit the second time, whatever quality it landed on, and a miss when the target changes", async () => {
    const item = itemWith([out("a-1280.avif", 1280, { search })]);
    const { root, fs } = await setup(item);
    const counter = { full: 0, crop: 0 };
    const first = await runPlan(planOf(item), {
      projectRoot: root,
      manifest: null,
      engine: engine(counter),
      fs,
      quality: { scorer: async () => scorer },
    });
    const manifest = updateManifest(null, planOf(item), first, {});
    const entry = manifest.sources["assets/a.jpg"];
    const hash = async (p: string) => {
      const d = await fs.readOutput(p);
      return d ? sha256(d) : null;
    };

    expect(await checkCache(item, entry, hash)).toEqual({ kind: "hit" });
    const encodesBefore = counter.full + counter.crop;
    const second = await runPlan(planOf(item), {
      projectRoot: root,
      manifest,
      engine: engine(counter),
      fs,
      quality: { scorer: async () => scorer },
    });
    expect(second.items[0]!.status).toBe("cached");
    expect(counter.full + counter.crop).toBe(encodesBefore);

    const stricter = itemWith([out("a-1280.avif", 1280, { search: { ...search, target: 90 } })]);
    expect(await checkCache(stricter, entry, hash)).toEqual({
      kind: "miss",
      reason: "outputs-differ",
    });
    const dropped = itemWith([out("a-1280.avif", 1280)]);
    expect(await checkCache(dropped, entry, hash)).toEqual({
      kind: "miss",
      reason: "outputs-differ",
    });
  });

  it("names a stepped-down output by its real width and still recognises it as the planned one", async () => {
    const item = itemWith([
      out("a-640.avif", 640, { search: { ...search, floor: 60, maxBytes: 20_000 } }),
      out("a-1280.avif", 1280, { search: { ...search, floor: 60, maxBytes: 20_000 } }),
    ]);
    const { root, outDir, fs } = await setup(item);
    const counter = { full: 0, crop: 0 };
    const result = await runPlan(planOf(item), {
      projectRoot: root,
      manifest: null,
      engine: engine(counter),
      fs,
      quality: { scorer: async () => scorer },
    });
    const [small, big] = result.items[0]!.outputs;
    expect(small).toMatchObject({ path: "a-640.avif", status: "written" });
    expect(big!.status).toBe("written");
    expect(big!.path).not.toBe("a-1280.avif");
    expect(big!.path).toMatch(/^a-(\d+)\.avif$/);
    expect(big!.width).toBe(Number(/a-(\d+)/.exec(big!.path)![1]));
    expect(big!.bytes).toBeLessThanOrEqual(20_000);
    expect(big!.search?.plannedPath).toBe("a-1280.avif");
    expect(result.warnings.join("\n")).toMatch(
      /stepped the width down from 1280px to \d+px to fit/,
    );
    expect(await listFiles(outDir)).toEqual([big!.path, "a-640.avif"].sort());

    // The manifest keeps it, the cache accepts it, and it is not reported as an orphan.
    const manifest = updateManifest(null, planOf(item), result, {});
    const hash = async (p: string) => {
      const d = await fs.readOutput(p);
      return d ? sha256(d) : null;
    };
    expect(await checkCache(item, manifest.sources["assets/a.jpg"], hash)).toEqual({ kind: "hit" });
    const orphans = await orphanedOutput.check({
      plan: planOf(item),
      manifest,
      encoders: { avif: "x", webp: "y" },
      sourceExists: async () => true,
      outputHash: hash,
    });
    expect(orphans).toEqual([]);
  });

  it("reports an unmet constraint, writes nothing for it, and fails the item", async () => {
    const item = itemWith([
      out("a-1280.avif", 1280, { search: { ...search, floor: 70, maxBytes: 1_000 } }),
    ]);
    const { root, outDir, fs } = await setup(item);
    const result = await runPlan(planOf(item), {
      projectRoot: root,
      manifest: null,
      engine: engine({ full: 0, crop: 0 }),
      fs,
      quality: { scorer: async () => scorer },
    });
    const o = result.items[0]!.outputs[0]!;
    expect(o.status).toBe("unmet");
    expect(o.error).toMatch(/over the 1\.0 KB cap/);
    expect(result.items[0]!.status).toBe("failed");
    expect(await listFiles(outDir)).toEqual([]);
    // Nothing is recorded, so the manifest does not claim an output it never made.
    expect(updateManifest(null, planOf(item), result, {}).sources).toEqual({});
  });

  it("never searches a lossless output", async () => {
    const item = itemWith([out("a-1280.avif", 1280, { lossless: true, search })]);
    const { root, fs } = await setup(item);
    const counter = { full: 0, crop: 0 };
    const result = await runPlan(planOf(item), {
      projectRoot: root,
      manifest: null,
      engine: engine(counter),
      fs,
      quality: { scorer: async () => scorer },
    });
    expect(counter.crop).toBe(0);
    expect(result.items[0]!.outputs[0]).toMatchObject({ status: "written", quality: 60 });
    expect(result.items[0]!.outputs[0]!.score).toBeUndefined();
  });

  it("without a scorer it uses the fixed quality and says so, instead of failing the run", async () => {
    const item = itemWith([out("a-1280.avif", 1280, { search })]);
    const { root, fs } = await setup(item);
    const result = await runPlan(planOf(item), {
      projectRoot: root,
      manifest: null,
      engine: engine({ full: 0, crop: 0 }),
      fs,
    });
    expect(result.items[0]!.outputs[0]).toMatchObject({ status: "written", quality: 60 });
    expect(result.warnings.join("\n")).toMatch(
      /no quality scorer available; used the fixed quality 60/,
    );
  });

  it("cancelling during a search records a cancelled output and writes nothing", async () => {
    const item = itemWith([out("a-1280.avif", 1280, { search })]);
    const { root, outDir, fs } = await setup(item);
    const controller = new AbortController();
    const result = await runPlan(planOf(item), {
      projectRoot: root,
      manifest: null,
      engine: engine({ full: 0, crop: 0 }),
      fs,
      signal: controller.signal,
      quality: {
        scorer: async () => {
          controller.abort();
          return scorer;
        },
      },
    });
    expect(result.items[0]!.outputs[0]!.status).toBe("cancelled");
    expect(await listFiles(outDir)).toEqual([]);
  });
});

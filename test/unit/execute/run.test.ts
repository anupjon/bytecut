import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EncodeRequest, ImageEngine } from "../../../src/core/engines/types.js";
import { runPlan } from "../../../src/core/execute/run.js";
import { sha256 } from "../../../src/core/hash.js";
import { SafeFs } from "../../../src/core/fs-safe.js";
import type { Plan, PlanItem } from "../../../src/core/plan/types.js";
import { listFiles, tempDir } from "../../helpers.js";

const output = (path: string, width: number): PlanItem["outputs"][number] => ({
  path,
  format: "avif",
  width,
  lossless: false,
  quality: 60,
  effort: 4,
});

function item(source: string, sourceBytes: number, widths: number[]): PlanItem {
  return {
    source,
    sourceBytes,
    sourceSha256: sha256(Buffer.alloc(sourceBytes, 1)),
    sourceWidth: 2000,
    sourceHeight: 1000,
    preset: "photo",
    outputs: widths.map((w) => output(`${source.replace(/\.jpg$/, "")}/${w}.avif`, w)),
  };
}

async function setup(plan: Plan) {
  const root = await tempDir();
  await mkdir(join(root, "assets"));
  for (const i of plan.items) await writeFile(join(root, i.source), Buffer.alloc(i.sourceBytes, 1));
  const outDir = join(root, "out");
  const fs = await SafeFs.create({
    projectRoot: root,
    outDir,
    sourceFiles: plan.items.map((i) => join(root, i.source)),
    sourceDirs: [],
  });
  return { root, outDir, fs };
}

/** Encodes to `bytesFor(request)` zero bytes. */
function fakeEngine(bytesFor: (r: EncodeRequest) => number, onEncode?: () => void): ImageEngine {
  return {
    async analyze() {
      throw new Error("not used");
    },
    encoders: () => ({ avif: "fake", webp: "fake" }),
    versions: () => ({}),
    async encode(_input, request) {
      onEncode?.();
      return {
        data: Buffer.alloc(bytesFor(request)),
        width: request.width,
        height: 10,
        encoder: "fake",
      };
    },
  };
}

describe("runPlan", () => {
  it("writes outputs and reports them", async () => {
    const plan: Plan = {
      version: 1,
      outDir: "out",
      publicPath: "/_bytecut",
      items: [item("assets/a.jpg", 1000, [640, 1280])],
    };
    const { root, outDir, fs } = await setup(plan);
    const result = await runPlan(plan, {
      projectRoot: root,
      manifest: null,
      engine: fakeEngine(() => 100),
      fs,
    });
    expect(result.items[0]?.status).toBe("done");
    expect(await listFiles(outDir)).toEqual(["assets/a/1280.avif", "assets/a/640.avif"]);
  });

  it("skips outputs that are not smaller than the source (§6.7)", async () => {
    const plan: Plan = {
      version: 1,
      outDir: "out",
      publicPath: "/_bytecut",
      items: [item("assets/a.jpg", 1000, [640, 1280])],
    };
    const { root, outDir, fs } = await setup(plan);
    const result = await runPlan(plan, {
      projectRoot: root,
      manifest: null,
      engine: fakeEngine((r) => (r.width === 640 ? 400 : 1000)),
      fs,
    });
    expect(result.items[0]?.outputs.map((o) => o.status)).toEqual(["written", "already-optimal"]);
    expect(await listFiles(outDir)).toEqual(["assets/a/640.avif"]);
  });

  it("isolates a failing file from the rest", async () => {
    const plan: Plan = {
      version: 1,
      outDir: "out",
      publicPath: "/_bytecut",
      items: [item("assets/bad.jpg", 1000, [640]), item("assets/good.jpg", 1000, [640])],
    };
    const { root, outDir, fs } = await setup(plan);
    // The first encode (the bad file's only output) fails; everything after succeeds.
    let calls = 0;
    const flaky: ImageEngine = {
      analyze: async () => {
        throw new Error("not used");
      },
      encoders: () => ({ avif: "fake", webp: "fake" }),
      versions: () => ({}),
      encode: async (_input, request) => {
        if (calls++ === 0) throw new Error("boom");
        return { data: Buffer.alloc(10), width: request.width, height: 1, encoder: "fake" };
      },
    };
    const result = await runPlan(plan, {
      projectRoot: root,
      manifest: null,
      engine: flaky,
      fs,
      concurrency: 1,
    });
    expect(result.items.map((i) => i.status)).toEqual(["failed", "done"]);
    expect(result.items[0]?.outputs[0]?.error).toBe("boom");
    expect(await listFiles(outDir)).toEqual(["assets/good/640.avif"]);
  });

  it("passes plan-skipped items through without encoding", async () => {
    const skipped: PlanItem = {
      ...item("assets/a.jpg", 1000, []),
      skip: { reason: "animated image" },
    };
    const plan: Plan = { version: 1, outDir: "out", publicPath: "/_bytecut", items: [skipped] };
    const { root, fs } = await setup(plan);
    const result = await runPlan(plan, {
      projectRoot: root,
      manifest: null,
      engine: fakeEngine(() => 1),
      fs,
    });
    expect(result.items[0]).toMatchObject({ status: "skipped", reason: "animated image" });
  });

  it("cancels mid-run without leaving partial files", async () => {
    const plan: Plan = {
      version: 1,
      outDir: "out",
      publicPath: "/_bytecut",
      items: [item("assets/a.jpg", 1000, [640, 1280, 1920]), item("assets/b.jpg", 1000, [640])],
    };
    const { root, outDir, fs } = await setup(plan);
    const controller = new AbortController();
    let encodes = 0;
    const result = await runPlan(plan, {
      projectRoot: root,
      manifest: null,
      fs,
      concurrency: 1,
      signal: controller.signal,
      engine: fakeEngine(
        () => 100,
        () => {
          if (++encodes === 2) controller.abort();
        },
      ),
    });
    expect(result.cancelled).toBe(true);
    expect(result.items[0]?.outputs.map((o) => o.status)).toEqual([
      "written",
      "written",
      "cancelled",
    ]);
    expect(result.items[1]?.status).toBe("cancelled");
    const files = await listFiles(outDir);
    expect(files).toEqual(["assets/a/1280.avif", "assets/a/640.avif"]);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("reports progress per item", async () => {
    const plan: Plan = {
      version: 1,
      outDir: "out",
      publicPath: "/_bytecut",
      items: [item("assets/a.jpg", 1000, [640]), item("assets/b.jpg", 1000, [640])],
    };
    const { root, fs } = await setup(plan);
    const seen: Array<[string, number, number]> = [];
    await runPlan(plan, {
      projectRoot: root,
      manifest: null,
      engine: fakeEngine(() => 10),
      fs,
      concurrency: 1,
      onItemDone: (r, done, total) => seen.push([r.source, done, total]),
    });
    expect(seen).toEqual([
      ["assets/a.jpg", 1, 2],
      ["assets/b.jpg", 2, 2],
    ]);
  });
});

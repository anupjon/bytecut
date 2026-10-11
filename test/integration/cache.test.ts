import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeImageFixtures } from "../../scripts/make-fixtures.js";
import { optimize } from "../../src/core/commands/optimize.js";
import { sharpImageEngine } from "../../src/core/engines/image.js";
import type { EncodeRequest, ImageEngine } from "../../src/core/engines/types.js";
import { sha256 } from "../../src/core/hash.js";
import { parseManifest } from "../../src/core/manifest/io.js";
import { parsePlan, serializePlan } from "../../src/core/plan/schema.js";
import { MODERN_POLICY, hashAll, listFiles, tempDir } from "../helpers.js";

// With MODERN_POLICY: small.jpg → 2 outputs (300w avif + webp), p3.jpg → 2 (500w): cheap to encode.
const FILES = ["small.jpg", "p3.jpg"];
const OUT = "public/_bytecut";
const MANIFEST = `${OUT}/bytecut-manifest.json`;

let templateDir: string;
beforeAll(async () => {
  templateDir = await mkdtemp(join(tmpdir(), "bytecut-cache-fixtures-"));
  await makeImageFixtures(templateDir);
});
afterAll(() => rm(templateDir, { recursive: true, force: true }));

async function project() {
  const root = await tempDir();
  await mkdir(join(root, "assets"));
  for (const f of FILES) await cp(join(templateDir, f), join(root, "assets", f));
  return root;
}

/** Real sharp engine that counts encodes and can abort after the Nth one. */
function countingEngine(abortAfter?: { n: number; controller: AbortController }) {
  const state = { encodes: 0 };
  const engine: ImageEngine = {
    ...sharpImageEngine,
    async encode(input: Buffer, request: EncodeRequest) {
      state.encodes++;
      const result = await sharpImageEngine.encode(input, request);
      if (abortAfter && state.encodes === abortAfter.n) abortAfter.controller.abort();
      return result;
    },
  };
  return { engine, state };
}

function run(
  root: string,
  engine: ImageEngine,
  extra: Partial<Parameters<typeof optimize>[0]> = {},
) {
  return optimize({
    projectRoot: root,
    engine,
    toolVersion: "test",
    inputs: ["assets"],
    outDir: OUT,
    execute: true,
    concurrency: 1,
    // The expectations below are two outputs (AVIF and WebP) per image.
    policy: MODERN_POLICY,
    ...extra,
  });
}

/** Output files, leaving out the analysis cache which is covered by its own tests. */
const outputFiles = async (dir: string) =>
  (await listFiles(dir)).filter((f) => !f.startsWith(".bytecut-cache/"));

const readManifest = async (root: string) =>
  parseManifest(await readFile(join(root, MANIFEST), "utf8"));

describe("cache (M2)", () => {
  it("a second run on unchanged sources does zero encodes and leaves the manifest identical", async () => {
    const root = await project();
    const first = countingEngine();
    await run(root, first.engine);
    expect(first.state.encodes).toBe(4);

    const manifestBefore = await readFile(join(root, MANIFEST), "utf8");
    const outputsBefore = await hashAll(join(root, OUT), await outputFiles(join(root, OUT)));

    const second = countingEngine();
    const outcome = await run(root, second.engine);

    expect(second.state.encodes).toBe(0);
    expect(outcome.result!.items.every((i) => i.status === "cached")).toBe(true);
    expect(await readFile(join(root, MANIFEST), "utf8")).toBe(manifestBefore);
    expect(await hashAll(join(root, OUT), await outputFiles(join(root, OUT)))).toEqual(
      outputsBefore,
    );
    expect(outcome.findings).toEqual([]);
  });

  it("re-encodes only the file whose content changed", async () => {
    const root = await project();
    await run(root, countingEngine().engine);
    const before = await readManifest(root);

    const changed = await sharp(join(root, "assets/small.jpg"))
      .modulate({ brightness: 1.4 })
      .jpeg()
      .toBuffer();
    await writeFile(join(root, "assets/small.jpg"), changed);

    const { engine, state } = countingEngine();
    const outcome = await run(root, engine);
    expect(state.encodes).toBe(2);

    const byName = Object.fromEntries(outcome.result!.items.map((i) => [i.source, i.status]));
    expect(byName).toEqual({ "assets/p3.jpg": "cached", "assets/small.jpg": "done" });

    const after = await readManifest(root);
    expect(after.sources["assets/small.jpg"]!.sha256).toBe(sha256(changed));
    expect(after.sources["assets/small.jpg"]!.sha256).not.toBe(
      before.sources["assets/small.jpg"]!.sha256,
    );
    expect(after.sources["assets/p3.jpg"]).toEqual(before.sources["assets/p3.jpg"]);
  });

  it("treats a touch (new mtime, same bytes) as unchanged", async () => {
    const root = await project();
    await run(root, countingEngine().engine);
    const future = new Date(Date.now() + 60_000);
    await utimes(join(root, "assets/small.jpg"), future, future);

    const { engine, state } = countingEngine();
    await run(root, engine);
    expect(state.encodes).toBe(0);
  });

  it("regenerates a deleted output", async () => {
    const root = await project();
    await run(root, countingEngine().engine);
    await rm(join(root, OUT, "assets/small-300.avif"));

    const dry = await run(root, countingEngine().engine, { execute: false });
    expect(dry.findings.map((f) => f.message)).toEqual([
      "an output file is missing; will be regenerated",
    ]);

    const { engine, state } = countingEngine();
    await run(root, engine);
    expect(state.encodes).toBe(2);
    expect(await listFiles(join(root, OUT))).toContain("assets/small-300.avif");
  });

  it("re-encodes everything with --force", async () => {
    const root = await project();
    await run(root, countingEngine().engine);
    const { engine, state } = countingEngine();
    await run(root, engine, { force: true });
    expect(state.encodes).toBe(4);
  });

  it("writes the manifest with tools, encoders and URLs, and no timestamps", async () => {
    const root = await project();
    await run(root, countingEngine().engine, { publicPath: "/static/img" });
    const manifest = await readManifest(root);
    expect(manifest.version).toBe(3);
    expect(manifest.publicPath).toBe("/static/img");
    expect(manifest.tools).toMatchObject({
      bytecut: "test",
      sharp: expect.any(String),
      vips: expect.any(String),
    });

    const small = manifest.sources["assets/small.jpg"]!;
    expect(small).toMatchObject({ preset: "photo", width: 300, height: 200 });
    const avif = small.outputs.find((o) => o.format === "avif")!;
    expect(avif).toMatchObject({
      path: "assets/small-300.avif",
      url: "/static/img/assets/small-300.avif",
      status: "written",
      encoder: expect.stringMatching(/^libaom-av1 \d/),
    });
    const written = await readFile(join(root, OUT, avif.path));
    expect(avif.sha256).toBe(sha256(written));
    expect(avif.bytes).toBe(written.byteLength);
  });
});

describe("guardrail 6: existing outputs we don't own", () => {
  it("leaves a hand-edited output alone and warns, unless --force", async () => {
    const root = await project();
    await run(root, countingEngine().engine);
    const target = join(root, OUT, "assets/small-300.webp");
    await writeFile(target, "hand edited");

    const normal = await run(root, countingEngine().engine);
    expect(await readFile(target, "utf8")).toBe("hand edited");
    expect(normal.result!.warnings).toHaveLength(1);
    expect(normal.result!.warnings[0]).toMatch(/small-300\.webp.*--force/);
    expect(normal.findings.some((f) => /modified/.test(f.message))).toBe(true);

    const forced = await run(root, countingEngine().engine, { force: true });
    expect(forced.result!.warnings).toEqual([]);
    expect((await readFile(target)).byteLength).toBeGreaterThan("hand edited".length);
  });

  it("protects a pre-existing file with no manifest entry, but accepts an identical one", async () => {
    const root = await project();
    const reference = await project();
    await run(reference, countingEngine().engine);
    const good = await readFile(join(reference, OUT, "assets/small-300.avif"));

    // Identical bytes already on disk (e.g. outputs from an M1 run): no write, no warning.
    await mkdir(join(root, OUT, "assets/small"), { recursive: true });
    await writeFile(join(root, OUT, "assets/small-300.avif"), good);
    // Different bytes in the way of the webp: must be left alone.
    await writeFile(join(root, OUT, "assets/small-300.webp"), "someone else's file");

    const outcome = await run(root, countingEngine().engine);
    const small = outcome.result!.items.find((i) => i.source === "assets/small.jpg")!;
    expect(Object.fromEntries(small.outputs.map((o) => [o.format, o.status]))).toEqual({
      avif: "unchanged",
      webp: "protected",
    });
    expect(await readFile(join(root, OUT, "assets/small-300.webp"), "utf8")).toBe(
      "someone else's file",
    );
    expect(outcome.result!.warnings).toHaveLength(1);

    // The protected file is not claimed by the manifest.
    const manifest = await readManifest(root);
    const paths = manifest.sources["assets/small.jpg"]!.outputs.map((o) => o.path);
    expect(paths).toEqual(["assets/small-300.avif"]);
  });
});

describe("analysis cache (inside outDir, §6.2)", () => {
  const CACHE = `${OUT}/.bytecut-cache`;

  it("is written on a real run, ignores itself, and is not written by a dry run", async () => {
    const root = await project();
    await run(root, countingEngine().engine, { execute: false });
    expect(await listFiles(join(root, OUT))).toEqual([]);

    await run(root, countingEngine().engine);
    expect(await readFile(join(root, CACHE, ".gitignore"), "utf8")).toBe("*\n");
    const cache = JSON.parse(await readFile(join(root, CACHE, "cache.json"), "utf8"));
    expect(Object.keys(cache.analyses)).toHaveLength(2);
  });

  it("is not rewritten when nothing new was analysed", async () => {
    const root = await project();
    await run(root, countingEngine().engine);
    const before = await readFile(join(root, CACHE, "cache.json"), "utf8");
    await utimes(join(root, CACHE, "cache.json"), new Date(0), new Date(0));
    await run(root, countingEngine().engine);
    expect(await readFile(join(root, CACHE, "cache.json"), "utf8")).toBe(before);
  });

  it("analyses each file once: a second plan uses the cached analysis", async () => {
    const root = await project();
    await run(root, countingEngine().engine);
    let analyses = 0;
    const engine: ImageEngine = {
      ...sharpImageEngine,
      async analyze(input) {
        analyses++;
        return sharpImageEngine.analyze(input);
      },
    };
    await run(root, engine);
    expect(analyses).toBe(0);
  });

  it("recovers from a corrupt cache file instead of failing", async () => {
    const root = await project();
    await run(root, countingEngine().engine);
    await writeFile(join(root, CACHE, "cache.json"), "{ garbage");
    const outcome = await run(root, countingEngine().engine);
    expect(outcome.result!.items.every((i) => i.status === "cached")).toBe(true);
  });

  it("is discarded when the encoder fingerprint changes", async () => {
    const root = await project();
    await run(root, countingEngine().engine);
    let analyses = 0;
    const engine: ImageEngine = {
      ...sharpImageEngine,
      versions: () => ({ sharp: "other", vips: "other" }),
      async analyze(input) {
        analyses++;
        return sharpImageEngine.analyze(input);
      },
    };
    await run(root, engine, { execute: false });
    expect(analyses).toBe(2);
  });
});

describe("manifest errors", () => {
  it("refuses a corrupt manifest and writes nothing", async () => {
    const root = await project();
    await mkdir(join(root, OUT), { recursive: true });
    await writeFile(join(root, MANIFEST), "{ not json");

    await expect(run(root, countingEngine().engine)).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
    });
    expect(await outputFiles(join(root, OUT))).toEqual(["bytecut-manifest.json"]);
    expect(await readFile(join(root, MANIFEST), "utf8")).toBe("{ not json");
  });

  it("refuses a pre-release version-1 manifest with a clear instruction", async () => {
    const root = await project();
    await mkdir(join(root, OUT), { recursive: true });
    await writeFile(join(root, MANIFEST), JSON.stringify({ version: 1 }));
    await expect(run(root, countingEngine().engine)).rejects.toMatchObject({
      code: "MANIFEST_OUTDATED",
    });
  });

  it("refuses a manifest from a newer bytecut", async () => {
    const root = await project();
    await mkdir(join(root, OUT), { recursive: true });
    await writeFile(join(root, MANIFEST), JSON.stringify({ version: 99 }));
    await expect(run(root, countingEngine().engine)).rejects.toMatchObject({
      code: "MANIFEST_UNSUPPORTED",
    });
  });
});

describe("project rules", () => {
  it("dry run reports a changed source as stale and writes nothing", async () => {
    const root = await project();
    await run(root, countingEngine().engine);
    const manifestBefore = await readFile(join(root, MANIFEST), "utf8");
    await writeFile(
      join(root, "assets/small.jpg"),
      await sharp(join(root, "assets/small.jpg")).negate().jpeg().toBuffer(),
    );

    const { engine, state } = countingEngine();
    const outcome = await run(root, engine, { execute: false });
    expect(state.encodes).toBe(0);
    expect(outcome.findings).toEqual([
      expect.objectContaining({
        ruleId: "project/stale-output",
        source: "assets/small.jpg",
        message: "source changed since the last run; will be regenerated",
      }),
    ]);
    expect(outcome.cache.get("assets/small.jpg")).toEqual({
      kind: "miss",
      reason: "source-changed",
    });
    expect(outcome.cache.get("assets/p3.jpg")).toEqual({ kind: "hit" });
    expect(await readFile(join(root, MANIFEST), "utf8")).toBe(manifestBefore);
  });

  it("reports outputs of a deleted source as orphaned and deletes nothing", async () => {
    const root = await project();
    await run(root, countingEngine().engine);
    await rm(join(root, "assets/small.jpg"));
    const filesBefore = await outputFiles(join(root, OUT));

    const outcome = await run(root, countingEngine().engine, { execute: false });
    const orphans = outcome.findings.filter((f) => f.ruleId === "project/orphaned-output");
    expect(orphans.map((f) => f.path)).toEqual(["assets/small-300.avif", "assets/small-300.webp"]);
    expect(orphans.every((f) => f.source === "assets/small.jpg")).toBe(true);

    // Even after a real run: reported, still not deleted, still in the manifest.
    const executed = await run(root, countingEngine().engine);
    expect(executed.findings.filter((f) => f.ruleId === "project/orphaned-output")).toHaveLength(2);
    expect(await outputFiles(join(root, OUT))).toEqual(filesBefore);
    expect((await readManifest(root)).sources["assets/small.jpg"]!.outputs).toHaveLength(2);
  });

  it("keeps outputs of sources outside this run's scope in the manifest", async () => {
    const root = await project();
    await run(root, countingEngine().engine);
    await run(root, countingEngine().engine, { inputs: ["assets/small.jpg"] });
    expect(Object.keys((await readManifest(root)).sources)).toEqual([
      "assets/p3.jpg",
      "assets/small.jpg",
    ]);
  });
});

describe("cancel mid-run (§6.4)", () => {
  it("leaves no partial files, records only what finished, and a re-run completes cleanly", async () => {
    const root = await project();
    const controller = new AbortController();
    // 4 encodes in total; abort after the second, i.e. after the first file is done.
    const { engine } = countingEngine({ n: 2, controller });
    const cancelled = await run(root, engine, { signal: controller.signal });

    expect(cancelled.result!.cancelled).toBe(true);
    const files = await outputFiles(join(root, OUT));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    const manifest = await readManifest(root);
    // p3.jpg sorts first and finished; small.jpg never started.
    expect(Object.keys(manifest.sources)).toEqual(["assets/p3.jpg"]);
    expect(files.filter((f) => f !== "bytecut-manifest.json").sort()).toEqual(
      manifest.sources["assets/p3.jpg"]!.outputs.map((o) => o.path).sort(),
    );

    const { engine: engine2, state } = countingEngine();
    const resumed = await run(root, engine2);
    expect(state.encodes).toBe(2); // only small.jpg
    expect(resumed.result!.warnings).toEqual([]);
    expect(resumed.result!.items.map((i) => i.status)).toEqual(["cached", "done"]);
  });
});

describe("saved plans (--plan)", () => {
  it("executes a saved plan to the same result as a direct run", async () => {
    const direct = await project();
    const viaPlan = await project();
    await run(direct, countingEngine().engine);

    const dry = await run(viaPlan, countingEngine().engine, { execute: false });
    const saved = parsePlan(serializePlan(dry.plan));
    const { engine, state } = countingEngine();
    await optimize({
      projectRoot: viaPlan,
      engine,
      toolVersion: "test",
      savedPlan: saved,
      outDir: saved.outDir,
      execute: true,
      concurrency: 1,
    });
    expect(state.encodes).toBe(4);

    const names = await outputFiles(join(direct, OUT));
    expect(await outputFiles(join(viaPlan, OUT))).toEqual(names);
    expect(await hashAll(join(viaPlan, OUT), names)).toEqual(
      await hashAll(join(direct, OUT), names),
    );
  });

  it("fails a file whose source changed after the plan was made, and writes nothing for it", async () => {
    const root = await project();
    const dry = await run(root, countingEngine().engine, { execute: false });
    const saved = parsePlan(serializePlan(dry.plan));
    await writeFile(
      join(root, "assets/small.jpg"),
      await sharp(join(root, "assets/small.jpg")).negate().jpeg().toBuffer(),
    );

    const { engine } = countingEngine();
    const outcome = await optimize({
      projectRoot: root,
      engine,
      toolVersion: "test",
      savedPlan: saved,
      outDir: saved.outDir,
      execute: true,
      concurrency: 1,
    });
    const small = outcome.result!.items.find((i) => i.source === "assets/small.jpg")!;
    expect(small.status).toBe("failed");
    expect(small.reason).toMatch(/source changed since the plan/);
    expect(await listFiles(join(root, OUT))).not.toContainEqual(
      expect.stringContaining("small-300"),
    );
  });
});

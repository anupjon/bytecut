import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeAuditProject } from "../../scripts/make-fixtures.js";
import { audit, type AuditOptions } from "../../src/core/commands/audit.js";
import { optimize } from "../../src/core/commands/optimize.js";
import { sharpImageEngine } from "../../src/core/engines/image.js";
import { svgoEngine } from "../../src/core/engines/svg.js";
import { hashAll, listFiles, tempDir } from "../helpers.js";

let template: string;
beforeAll(async () => {
  template = await mkdtemp(join(tmpdir(), "bytecut-audit-template-"));
  await makeAuditProject(template);
});
afterAll(() => rm(template, { recursive: true, force: true }));

async function project(): Promise<string> {
  const root = await tempDir();
  await cp(template, root, { recursive: true });
  return root;
}

const OUT = "public/_bytecut";

function run(root: string, over: Partial<AuditOptions> = {}) {
  return audit({
    projectRoot: root,
    engine: sharpImageEngine,
    svgEngine: svgoEngine,
    inputs: ["public"],
    outDir: OUT,
    staticRoot: "public",
    ffmpeg: { found: true, installHint: "sudo apt install ffmpeg" },
    persistCache: false,
    ...over,
  });
}

describe("audit of a fixture project", () => {
  it("lists the expected rule hits (golden)", async () => {
    const report = await run(await project());
    // Structure only: sizes depend on the platform's libjpeg/libaom builds, hits do not.
    const hits = report.findings.map(({ ruleId, severity, source, path }) => ({
      ruleId,
      severity,
      source,
      ...(path ? { path } : {}),
    }));
    await expect(`${JSON.stringify(hits, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/audit-hits.json",
    );
  });

  it("counts what it scanned and notes the unanalysed video", async () => {
    const report = await run(await project());
    expect(report.counts).toEqual({ images: 10, svgs: 2, videos: 1, skipped: 1 });
    expect(report.notes.join(" ")).toMatch(/1 video file found but not analysed/);
    expect(report.totals.potentialSavingsBytes).toBeGreaterThan(0);
    expect(report.totals.optimizedImages).toBe(0);
  });

  it("respects .gitignore", async () => {
    const report = await run(await project());
    expect(report.findings.some((f) => f.source?.includes("ignored/"))).toBe(false);
  });

  it("never modifies sources", async () => {
    const root = await project();
    const names = (await listFiles(root)).filter(
      (f) => f.startsWith("public/") || f.startsWith("app/"),
    );
    const before = await hashAll(root, names);
    await run(root, { persistCache: true });
    expect(await hashAll(root, names)).toEqual(before);
  });
});

describe("rule settings", () => {
  it("can turn a rule off, change severity and override options", async () => {
    const report = await run(await project(), {
      settings: {
        "project/unreferenced": "off",
        "image/no-responsive-set": "warn",
        "image/heavy": ["error", { maxBytes: 100_000 }],
      },
    });
    const ids = new Set(report.findings.map((f) => f.ruleId));
    expect(ids.has("project/unreferenced")).toBe(false);

    const responsive = report.findings.filter((f) => f.ruleId === "image/no-responsive-set");
    expect(responsive.length).toBeGreaterThan(0);
    expect(responsive.every((f) => f.severity === "warn")).toBe(true);

    const heavy = report.findings.filter((f) => f.ruleId === "image/heavy");
    expect(heavy.map((f) => f.source).sort()).toEqual([
      "public/img/diagram.png",
      "public/img/hero.jpg",
      "public/img/photo-big.jpg",
    ]);
    expect(heavy.every((f) => f.severity === "error")).toBe(true);
  });

  it("applies budgets as errors", async () => {
    const report = await run(await project(), {
      budgets: { maxFileBytes: 150_000, maxTotalBytes: 400_000 },
    });
    const budget = report.findings.filter((f) => f.ruleId === "project/over-budget");
    expect(budget.every((f) => f.severity === "error")).toBe(true);
    expect(budget.map((f) => f.source ?? "(total)")).toEqual(
      expect.arrayContaining(["public/img/diagram.png", "public/img/photo-big.jpg", "(total)"]),
    );
  });

  it("says what to install when ffmpeg is missing", async () => {
    const report = await run(await project(), {
      ffmpeg: { found: false, installHint: "brew install ffmpeg" },
    });
    const gif = report.findings.find((f) => f.ruleId === "gif/animated")!;
    expect(gif.message).toMatch(/Needs ffmpeg: brew install ffmpeg/);
  });
});

describe("audit cache location (§6.2)", () => {
  it("writes nothing at all with persistCache: false", async () => {
    const root = await project();
    await run(root);
    expect(await listFiles(join(root, OUT))).toEqual([]);
  });

  it("writes only the self-ignoring cache inside outDir, never a manifest", async () => {
    const root = await project();
    await run(root, { persistCache: true });
    expect(await listFiles(join(root, OUT))).toEqual([
      ".bytecut-cache/.gitignore",
      ".bytecut-cache/cache.json",
    ]);
    expect(await readFile(join(root, OUT, ".bytecut-cache/.gitignore"), "utf8")).toBe("*\n");
  });

  it("reuses it: a warm audit analyses and encodes nothing", async () => {
    const root = await project();
    await run(root, { persistCache: true });

    let analyses = 0;
    let encodes = 0;
    const counting = {
      ...sharpImageEngine,
      async analyze(input: Buffer) {
        analyses++;
        return sharpImageEngine.analyze(input);
      },
      async encode(...args: Parameters<typeof sharpImageEngine.encode>) {
        encodes++;
        return sharpImageEngine.encode(...args);
      },
    };
    const warm = await run(root, { engine: counting, persistCache: true });
    expect(analyses).toBe(0);
    expect(encodes).toBe(0);
    expect(warm.findings.length).toBeGreaterThan(0);
  });
});

describe("audit after optimize", () => {
  it("source-level issues disappear once outputs are up to date, and return if a source changes", async () => {
    const root = await project();
    const before = await run(root);
    expect(before.findings.some((f) => f.ruleId === "image/no-modern-format")).toBe(true);

    await optimize({
      projectRoot: root,
      engine: sharpImageEngine,
      toolVersion: "test",
      inputs: ["public"],
      outDir: OUT,
      staticRoot: "public",
      execute: true,
    });

    const after = await run(root);
    const sourceRules = new Set([
      "image/no-modern-format",
      "image/oversized-dimensions",
      "image/photo-as-png",
      "image/metadata",
      "image/no-responsive-set",
      "image/cmyk-or-16bit",
      "gif/static",
      "image/reencode-savings",
    ]);
    expect(after.findings.filter((f) => sourceRules.has(f.ruleId))).toEqual([]);
    expect(after.totals.optimizedImages).toBe(10);
    expect(after.totals.potentialSavingsBytes).toBe(0);
    // Not resolved by optimizing images: SVG issues, the animated GIF and project hygiene.
    expect(after.findings.some((f) => f.ruleId === "svg/unminified")).toBe(true);
    expect(after.findings.some((f) => f.ruleId === "gif/animated")).toBe(true);
    expect(after.findings.some((f) => f.ruleId === "project/duplicate")).toBe(true);

    const hero = join(root, "public/img/hero.jpg");
    await writeFile(hero, await sharp(hero).negate().jpeg({ quality: 80 }).toBuffer());
    const changed = await run(root);
    expect(
      changed.findings.some(
        (f) => f.ruleId === "image/no-modern-format" && f.source === "public/img/hero.jpg",
      ),
    ).toBe(true);
    expect(
      changed.findings.some(
        (f) => f.ruleId === "project/stale-output" && f.source === "public/img/hero.jpg",
      ),
    ).toBe(true);
  });
});

describe("references", () => {
  it("finds references in css url(), JS imports and markdown, outside the scanned folder", async () => {
    const root = await project();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src/a.css"),
      '.x { background: url("/img/still.gif"); } .y { background: url(/img/cmyk.jpg) }',
    );
    await writeFile(join(root, "src/b.ts"), "import deep from '../public/img/deep.png';\n");
    await writeFile(
      join(root, "README.md"),
      "![](./public/img/with-meta.jpg) and %6Cogo-copy.png\n",
    );
    const report = await run(root);
    const orphans = report.findings
      .filter((f) => f.ruleId === "project/unreferenced")
      .map((f) => f.source);
    expect(orphans).toEqual(["public/icons/inline-photo.svg"]);
  });
});

describe("200-file project (§M3 performance)", () => {
  it("audits in under 10 seconds on a warm cache", async () => {
    const root = await tempDir();
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15" } }));
    await mkdir(join(root, "public/img"), { recursive: true });
    for (let i = 0; i < 200; i++) {
      const w = 48 + (i % 7) * 16;
      const h = 40 + (i % 5) * 12;
      const buf = Buffer.alloc(w * h * 3);
      for (let p = 0; p < buf.length; p++) buf[p] = (p * (i + 3) + ((p >> 3) ^ i)) & 255;
      const image = sharp(buf, { raw: { width: w, height: h, channels: 3 } });
      const out = join(root, "public/img", `img-${String(i).padStart(3, "0")}`);
      if (i % 3 === 0) await image.png().toFile(`${out}.png`);
      else await image.jpeg({ quality: 80 }).toFile(`${out}.jpg`);
    }

    const t0 = performance.now();
    const cold = await run(root, { persistCache: true });
    const coldMs = performance.now() - t0;

    const t1 = performance.now();
    const warm = await run(root, { persistCache: true });
    const warmMs = performance.now() - t1;

    expect(cold.counts.images).toBe(200);
    expect(warm.findings).toEqual(cold.findings);
    console.info(`200 files: cold ${Math.round(coldMs)} ms, warm ${Math.round(warmMs)} ms`);
    expect(warmMs).toBeLessThan(10_000);
  }, 180_000);
});

// Silence unused import warnings for helpers kept for readability of failures.
void utimes;

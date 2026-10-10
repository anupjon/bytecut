import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAGE_FIXTURES, makeImageFixtures } from "../../scripts/make-fixtures.js";
import { sharpImageEngine } from "../../src/core/engines/image.js";
import { optimize as optimizeCommand } from "../../src/core/commands/optimize.js";
import type { RunResult } from "../../src/core/execute/run.js";
import { collectAssets } from "../../src/core/scan/collect.js";
import { hashAll, listFiles, tempDir } from "../helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");

let templateDir: string;
let shared: {
  root: string;
  outDir: string;
  result: RunResult;
  sourceHashes: Record<string, string>;
};
// Shared across tests, so it must outlive the per-test cleanup that tempDir() registers.
beforeAll(async () => {
  templateDir = await mkdtemp(join(tmpdir(), "bytecut-fixtures-"));
  await makeImageFixtures(templateDir);

  // AVIF encoding is slow, so the read-only assertions share one full run.
  const root = await mkdtemp(join(tmpdir(), "bytecut-shared-"));
  await cp(templateDir, join(root, "assets"), { recursive: true });
  const sourceHashes = await hashAll(join(root, "assets"), IMAGE_FIXTURES);
  const { outDir, result } = await optimize(root);
  shared = { root, outDir, result, sourceHashes };
}, 120_000);
afterAll(async () => {
  await rm(templateDir, { recursive: true, force: true });
  await rm(shared.root, { recursive: true, force: true });
});

/** A fresh project with the fixtures under assets/. */
async function newProject() {
  const root = await tempDir();
  await cp(templateDir, join(root, "assets"), { recursive: true });
  return root;
}

async function optimize(root: string, inputs: string[] = ["assets"], outRel = "public/_bytecut") {
  const outcome = await optimizeCommand({
    projectRoot: root,
    engine: sharpImageEngine,
    toolVersion: "test",
    inputs,
    outDir: outRel,
    execute: true,
  });
  return {
    outDir: resolve(root, outRel),
    plan: outcome.plan,
    result: outcome.result!,
  };
}

async function meta(outDir: string, rel: string) {
  return sharp(join(outDir, rel)).metadata();
}

describe("optimize (M1)", () => {
  it("writes the expected layout and leaves sources untouched", async () => {
    const { root, outDir, result, sourceHashes } = shared;

    expect(await hashAll(join(root, "assets"), IMAGE_FIXTURES)).toEqual(sourceHashes);
    expect(result.items.every((i) => i.status === "done")).toBe(true);

    const files = await listFiles(outDir);
    expect(files).toEqual(
      expect.arrayContaining([
        "assets/photo/photo-640.avif",
        "assets/photo/photo-640.webp",
        "assets/photo/photo-1280.avif",
        "assets/photo/photo-1280.webp",
        "assets/photo/photo-1400.avif",
        "assets/oversized/oversized-1920.webp",
        "assets/oversized/oversized-2560.avif",
        "assets/flat-alpha/flat-alpha-512.avif",
      ]),
    );
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    // Only AVIF, WebP and the manifest; nothing written next to the sources.
    expect(files).toContain("bytecut-manifest.json");
    expect(
      files.every((f) =>
        /\.(avif|webp)$|^bytecut-manifest\.json$|^\.bytecut-cache\/(cache\.json|\.gitignore)$/.test(
          f,
        ),
      ),
    ).toBe(true);
    expect(await listFiles(join(root, "assets"))).toEqual([...IMAGE_FIXTURES].sort());
  });

  it("produces the right formats and dimensions, never upscaling", async () => {
    const { outDir } = shared;

    const avif = await meta(outDir, "assets/photo/photo-1280.avif");
    expect(avif.format).toBe("heif");
    expect(avif.compression).toBe("av1");
    expect(avif.width).toBe(1280);

    const webp = await meta(outDir, "assets/photo/photo-640.webp");
    expect(webp.format).toBe("webp");
    expect(webp.width).toBe(640);

    // 1400px source: largest output is its native width, not 1920.
    expect((await meta(outDir, "assets/photo/photo-1400.avif")).width).toBe(1400);
    expect(await listFiles(join(outDir, "assets/photo"))).not.toContain("photo-1920.avif");

    // 300px source: one output at native width.
    expect((await meta(outDir, "assets/small/small-300.webp")).width).toBe(300);

    // Oversized source is classified as hero (wide + large), which tops out at 2560.
    expect((await meta(outDir, "assets/oversized/oversized-2560.avif")).width).toBe(2560);
    expect(await listFiles(join(outDir, "assets/oversized"))).toHaveLength(8);

    // Flat art is classified as icon: small widths, none above 512 even for a 600px source.
    expect(await listFiles(join(outDir, "assets/flat-alpha"))).toEqual([
      "flat-alpha-128.avif",
      "flat-alpha-128.webp",
      "flat-alpha-256.avif",
      "flat-alpha-256.webp",
      "flat-alpha-512.avif",
      "flat-alpha-512.webp",
      "flat-alpha-64.avif",
      "flat-alpha-64.webp",
    ]);
  });

  it("applies EXIF rotation before stripping metadata", async () => {
    const { outDir } = shared;
    // Stored 800x500 with orientation 6, so it must come out 500x800 and without an EXIF block.
    const out = await meta(outDir, "assets/rotated-exif/rotated-exif-500.webp");
    expect([out.width, out.height]).toEqual([500, 800]);
    expect(out.exif).toBeUndefined();
    expect(out.orientation === undefined || out.orientation === 1).toBe(true);
  });

  it("strips GPS and other EXIF", async () => {
    const { root, outDir } = shared;
    const source = await sharp(join(root, "assets/gps.jpg")).metadata();
    expect(source.exif).toBeDefined(); // precondition: the fixture really carries EXIF

    for (const rel of ["assets/gps/gps-640.avif", "assets/gps/gps-640.webp"]) {
      expect((await meta(outDir, rel)).exif).toBeUndefined();
    }
  });

  it("keeps the ICC profile unchanged", async () => {
    const { root, outDir } = shared;
    const source = await sharp(join(root, "assets/p3.jpg")).metadata();
    expect(source.icc).toBeDefined(); // precondition: the fixture is really tagged
    for (const rel of ["assets/p3/p3-500.avif", "assets/p3/p3-500.webp"]) {
      const out = await meta(outDir, rel);
      // Same bytes as the source profile: not dropped and not converted to sRGB.
      expect(out.icc?.equals(source.icc!)).toBe(true);
    }
  });

  it("preserves alpha", async () => {
    const { outDir } = shared;
    expect((await meta(outDir, "assets/flat-alpha/flat-alpha-512.avif")).hasAlpha).toBe(true);
    expect((await meta(outDir, "assets/flat-alpha/flat-alpha-512.webp")).hasAlpha).toBe(true);
  });

  it("never writes an output larger than its source", async () => {
    const { outDir, result } = shared;
    for (const item of result.items) {
      for (const out of item.outputs.filter((o) => o.status === "written")) {
        expect(out.bytes).toBeLessThan(item.sourceBytes);
      }
    }
    expect(await listFiles(outDir)).not.toHaveLength(0);
  });

  it("is deterministic: the same input yields byte-identical outputs", async () => {
    const root = await newProject();
    const first = await optimize(root, ["assets/photo.jpg"], "out-a");
    const second = await optimize(root, ["assets/photo.jpg"], "out-b");
    const names = await listFiles(first.outDir);
    expect(names).toEqual(await listFiles(second.outDir));
    for (const name of names) {
      expect(await hashAll(first.outDir, [name])).toEqual(await hashAll(second.outDir, [name]));
    }
  });

  it("skips node_modules and the output folder when scanning a directory", async () => {
    const root = await newProject();
    await mkdir(join(root, "assets/node_modules/pkg"), { recursive: true });
    await cp(join(root, "assets/photo.jpg"), join(root, "assets/node_modules/pkg/x.jpg"));
    await mkdir(join(root, "assets/_bytecut"), { recursive: true });
    await cp(join(root, "assets/photo.jpg"), join(root, "assets/_bytecut/old.jpg"));

    const found = await collectAssets(["assets"], {
      cwd: root,
      outDir: join(root, "assets/_bytecut"),
    });
    expect(found.files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(found.files.some((f) => f.includes("_bytecut"))).toBe(false);
    expect(found.files).toHaveLength(IMAGE_FIXTURES.length);
  });

  it("does not follow symlinks while scanning", async () => {
    const root = await newProject();
    const outside = await tempDir();
    await cp(join(root, "assets/photo.jpg"), join(outside, "secret.jpg"));
    await symlink(outside, join(root, "assets/linked-dir"));
    await symlink(join(outside, "secret.jpg"), join(root, "assets/linked.jpg"));

    const found = await collectAssets(["assets"], { cwd: root, outDir: join(root, "out") });
    expect(found.files.some((f) => f.includes("secret") || f.includes("linked"))).toBe(false);
  });

  it("isolates a corrupt image and still processes the rest", async () => {
    const root = await newProject();
    await writeFile(join(root, "assets/corrupt.jpg"), "not an image");
    const { plan, result, outDir } = await optimize(root, [
      "assets/corrupt.jpg",
      "assets/small.jpg",
    ]);
    expect(plan.items.find((i) => i.source === "assets/corrupt.jpg")?.skip?.reason).toMatch(
      /corrupt/,
    );
    expect(result.items.find((i) => i.source === "assets/corrupt.jpg")?.status).toBe("skipped");
    expect(await listFiles(outDir)).toContain("assets/small/small-300.avif");
  });
});

describe("bytecut optimize CLI (headless)", () => {
  const cli = (cwd: string, args: string[]) =>
    execFileAsync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), join(repoRoot, "src/cli/index.ts"), ...args],
      { cwd },
    );

  it("prints the plan and writes nothing without -y (§6.13)", async () => {
    const root = await newProject();
    const { stdout } = await cli(root, ["optimize", "assets/photo.jpg"]);
    expect(stdout).toContain("Plan: 1 image");
    expect(stdout).toContain("assets/photo/photo-640.avif");
    expect(stdout).toContain("Dry run");
    expect(await listFiles(join(root, "_bytecut"))).toEqual([]);
  });

  it("writes outputs and a summary with -y", async () => {
    const root = await newProject();
    const before = await hashAll(join(root, "assets"), IMAGE_FIXTURES);
    const { stdout } = await cli(root, ["optimize", "assets/small.jpg", "assets/p3.jpg", "-y"]);
    expect(stdout).toMatch(/Total: \d+ files written/);
    expect(await listFiles(join(root, "_bytecut"))).toContain("assets/small/small-300.avif");
    expect(await hashAll(join(root, "assets"), IMAGE_FIXTURES)).toEqual(before);
  });

  it("honours --out-dir", async () => {
    const root = await newProject();
    await cli(root, ["optimize", "assets/small.jpg", "-y", "--out-dir", "dist-img"]);
    expect(await listFiles(join(root, "dist-img"))).toEqual([
      ".bytecut-cache/.gitignore",
      ".bytecut-cache/cache.json",
      "assets/small/small-300.avif",
      "assets/small/small-300.webp",
      "bytecut-manifest.json",
    ]);
  });

  it("refuses an output folder that is the project root", async () => {
    const root = await newProject();
    await expect(cli(root, ["optimize", "assets", "-y", "--out-dir", "."])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("UNSAFE_OUT_DIR"),
    });
    expect(await listFiles(root)).toEqual([...IMAGE_FIXTURES].map((f) => `assets/${f}`).sort());
  });

  it("fails clearly for a missing input", async () => {
    const root = await newProject();
    await expect(cli(root, ["optimize", "nope", "-y"])).rejects.toMatchObject({
      stderr: expect.stringContaining("INPUT_NOT_FOUND"),
    });
  });
});

describe("bytecut optimize CLI: plans and manifest (M2)", () => {
  const cli = (cwd: string, args: string[]) =>
    execFileAsync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), join(repoRoot, "src/cli/index.ts"), ...args],
      { cwd },
    );
  const fail = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected the command to fail");
      },
      (e: { code: number; stderr: string }) => e,
    );

  it("--dry-run --json prints only the plan JSON on stdout and writes nothing", async () => {
    const root = await newProject();
    const { stdout } = await cli(root, ["optimize", "assets/small.jpg", "--dry-run", "--json"]);
    const plan = JSON.parse(stdout);
    expect(plan).toMatchObject({ version: 1, outDir: "_bytecut", publicPath: "/_bytecut" });
    expect(plan.items[0].source).toBe("assets/small.jpg");
    expect(plan.items[0].sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await listFiles(join(root, "_bytecut"))).toEqual([]);
  });

  it("--dry-run wins even with -y", async () => {
    const root = await newProject();
    await cli(root, ["optimize", "assets/small.jpg", "-y", "--dry-run"]);
    expect(await listFiles(join(root, "_bytecut"))).toEqual([]);
  });

  it("saves a plan and executes it with --plan -y", async () => {
    const root = await newProject();
    const { stdout } = await cli(root, ["optimize", "assets/small.jpg", "--dry-run", "--json"]);
    await writeFile(join(root, "saved-plan.json"), stdout);

    const shown = await cli(root, ["optimize", "--plan", "saved-plan.json"]);
    expect(shown.stdout).toContain("Dry run");
    expect(await listFiles(join(root, "_bytecut"))).toEqual([]);

    const ran = await cli(root, ["optimize", "--plan", "saved-plan.json", "-y"]);
    expect(ran.stdout).toMatch(/Total: 2 files written/);
    // A saved plan is executed without analysing anything, so no analysis cache is written.
    expect(await listFiles(join(root, "_bytecut"))).toEqual([
      "assets/small/small-300.avif",
      "assets/small/small-300.webp",
      "bytecut-manifest.json",
    ]);
  });

  it("reports a second run as unchanged and writes nothing new", async () => {
    const root = await newProject();
    await cli(root, ["optimize", "assets/small.jpg", "-y"]);
    const manifest = await readFile(join(root, "_bytecut/bytecut-manifest.json"), "utf8");

    const again = await cli(root, ["optimize", "assets/small.jpg", "-y"]);
    expect(again.stdout).toContain("unchanged");
    expect(again.stdout).toMatch(/Total: 0 files written, 1 image unchanged/);
    expect(await readFile(join(root, "_bytecut/bytecut-manifest.json"), "utf8")).toBe(manifest);

    const dry = await cli(root, ["optimize", "assets/small.jpg"]);
    expect(dry.stdout).toContain("1 unchanged, will be skipped");
  });

  it("rejects a tampered plan whose source escapes the project", async () => {
    const root = await newProject();
    const { stdout } = await cli(root, ["optimize", "assets/small.jpg", "--dry-run", "--json"]);
    const plan = JSON.parse(stdout);
    plan.items[0].source = "../../etc/passwd";
    await writeFile(join(root, "evil.json"), JSON.stringify(plan));

    const error = await fail(cli(root, ["optimize", "--plan", "evil.json", "-y"]));
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("PLAN_INVALID");
    // Expected user errors are one clean line, never a stack trace (§7).
    expect(error.stderr).not.toMatch(/\n\s+at /);
    expect(error.stderr.trim().split("\n")).toHaveLength(1);
    expect(await listFiles(join(root, "_bytecut"))).toEqual([]);
  });

  it("rejects a plan whose output would escape outDir", async () => {
    const root = await newProject();
    const { stdout } = await cli(root, ["optimize", "assets/small.jpg", "--dry-run", "--json"]);
    const plan = JSON.parse(stdout);
    plan.items[0].outputs[0].path = "../../escaped.avif";
    await writeFile(join(root, "evil.json"), JSON.stringify(plan));

    const error = await fail(cli(root, ["optimize", "--plan", "evil.json", "-y"]));
    expect(error.stderr).toContain("PLAN_INVALID");
    expect(await listFiles(root)).not.toContainEqual(expect.stringContaining("escaped"));
  });

  it("rejects --json without --dry-run and --plan combined with paths", async () => {
    const root = await newProject();
    const a = await fail(cli(root, ["optimize", "assets/small.jpg", "-y", "--json"]));
    expect(a.stderr).toContain("BAD_ARGUMENTS");
    const b = await fail(cli(root, ["optimize", "assets", "--plan", "x.json"]));
    expect(b.stderr).toContain("BAD_ARGUMENTS");
  });

  it("fails clearly when the plan file is missing", async () => {
    const root = await newProject();
    const error = await fail(cli(root, ["optimize", "--plan", "nope.json", "-y"]));
    expect(error.stderr).toContain("INPUT_NOT_FOUND");
  });
});

describe("zero-config CLI: detection and audit (M3)", () => {
  const cli = (cwd: string, args: string[]) =>
    execFileAsync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), join(repoRoot, "src/cli/index.ts"), ...args],
      { cwd },
    );
  const fail = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected the command to fail");
      },
      (e: { code: number; stderr: string; stdout: string }) => e,
    );

  async function nextProject() {
    const root = await tempDir();
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15" } }));
    await mkdir(join(root, "public/img"), { recursive: true });
    await cp(join(templateDir, "small.jpg"), join(root, "public/img/small.jpg"));
    await cp(join(templateDir, "p3.jpg"), join(root, "public/img/p3.jpg"));
    return root;
  }

  it("`optimize` with no paths scans the framework's folder and uses the static-root layout", async () => {
    const root = await nextProject();
    const { stdout, stderr } = await cli(root, ["optimize", "-y"]);
    expect(stderr).toContain("Detected Next.js: scanning public → public/_bytecut");
    expect(stdout).toMatch(/Total: 4 files written/);
    expect(await listFiles(join(root, "public/_bytecut"))).toEqual([
      ".bytecut-cache/.gitignore",
      ".bytecut-cache/cache.json",
      "bytecut-manifest.json",
      "img/p3/p3-500.avif",
      "img/p3/p3-500.webp",
      "img/small/small-300.avif",
      "img/small/small-300.webp",
    ]);
    const manifest = JSON.parse(
      await readFile(join(root, "public/_bytecut/bytecut-manifest.json"), "utf8"),
    );
    expect(manifest.version).toBe(3);
    expect(manifest.sources["public/img/small.jpg"].outputs[0].url).toBe(
      "/_bytecut/img/small/small-300.avif",
    );
  });

  it("`--preset` forces a preset for every image", async () => {
    const root = await nextProject();
    const { stdout } = await cli(root, ["optimize", "--preset", "icon"]);
    expect(stdout).toContain("icon: forced with --preset icon");
    const bad = await fail(cli(root, ["optimize", "--preset", "nope"]));
    expect(bad.stderr).toMatch(/Unknown preset "nope"/);
  });

  it("`audit` reports findings and exits 0", async () => {
    const root = await nextProject();
    const { stdout } = await cli(root, ["audit"]);
    expect(stdout).toContain("image/no-modern-format");
    expect(stdout).toContain("public/img/small.jpg");
    expect(stdout).toMatch(/Estimated savings from optimizing/);
  });

  it("`audit --json` is parseable and `--no-cache` writes nothing", async () => {
    const root = await nextProject();
    const { stdout } = await cli(root, ["audit", "--json", "--no-cache"]);
    const report = JSON.parse(stdout);
    expect(report.version).toBe(1);
    expect(report.project.framework).toBe("next");
    expect(report.counts.images).toBe(2);
    expect(await listFiles(join(root, "public/_bytecut"))).toEqual([]);
  });

  it("`audit` by default keeps its cache inside outDir only", async () => {
    const root = await nextProject();
    await cli(root, ["audit"]);
    expect(await listFiles(join(root, "public/_bytecut"))).toEqual([
      ".bytecut-cache/.gitignore",
      ".bytecut-cache/cache.json",
    ]);
  });

  it("both commands fail clearly when there is nothing to scan", async () => {
    const root = await tempDir();
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { vite: "6" } }));
    for (const command of ["audit", "optimize"]) {
      const error = await fail(cli(root, [command]));
      expect(error.code).toBe(2);
      expect(error.stderr).toMatch(/no asset folder found/);
    }
  });
});

describe("plain `bytecut` when it is not an interactive terminal (M4)", () => {
  const cli = (cwd: string, args: string[], env: Record<string, string> = {}) =>
    execFileAsync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), join(repoRoot, "src/cli/index.ts"), ...args],
      { cwd, env: { ...process.env, ...env } },
    );

  async function nextProject() {
    const root = await tempDir();
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15" } }));
    await mkdir(join(root, "public/img"), { recursive: true });
    await cp(join(templateDir, "small.jpg"), join(root, "public/img/small.jpg"));
    return root;
  }

  it("prints the audit report and a hint, exits 0, and writes nothing", async () => {
    const root = await nextProject();
    const { stdout } = await cli(root, []);
    expect(stdout).toContain("image/no-modern-format");
    expect(stdout).toContain("public/img/small.jpg");
    expect(stdout).toMatch(/Not an interactive terminal\. Run `bytecut optimize -y`/);
    // Not even the analysis cache: a bare `npx bytecut` in CI must not touch the repo (§6.13).
    expect(await listFiles(join(root, "public"))).toEqual(["img/small.jpg"]);
  });

  it("does the same under CI=true", async () => {
    const root = await nextProject();
    const { stdout } = await cli(root, [], { CI: "true" });
    expect(stdout).toContain("image/no-modern-format");
    expect(await listFiles(join(root, "public"))).toEqual(["img/small.jpg"]);
  });

  it("fails clearly when there is nothing to scan", async () => {
    const root = await tempDir();
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { vite: "6" } }));
    const error = await cli(root, []).then(
      () => {
        throw new Error("expected failure");
      },
      (e: { code: number; stderr: string }) => e,
    );
    expect(error.code).toBe(2);
    expect(error.stderr).toMatch(/no asset folder found/);
  });

  it("a subcommand is not followed by the default action (citty runs the parent's run too)", async () => {
    const root = await nextProject();
    const doctor = await cli(root, ["doctor", "--json"]);
    // Pure JSON: no audit report appended, and nothing written into the project.
    expect(() => JSON.parse(doctor.stdout)).not.toThrow();
    expect(await listFiles(join(root, "public"))).toEqual(["img/small.jpg"]);

    const dry = await cli(root, ["optimize", "public/img/small.jpg", "--dry-run", "--json"]);
    expect(() => JSON.parse(dry.stdout)).not.toThrow();
    expect(dry.stdout).not.toContain("Not an interactive terminal");
  });

  it("--help and subcommands are unaffected", async () => {
    const root = await nextProject();
    const help = await cli(root, ["--help"]);
    expect(help.stdout).toMatch(/audit\|optimize\|doctor/);
    const audit = await cli(root, ["audit", "--no-cache"]);
    expect(audit.stdout).toContain("image/no-modern-format");
  });
});

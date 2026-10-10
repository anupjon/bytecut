import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeImageFixtures } from "../../scripts/make-fixtures.js";
import { optimize } from "../../src/core/commands/optimize.js";
import { sharpImageEngine } from "../../src/core/engines/image.js";
import type { EncodeRequest, ImageEngine } from "../../src/core/engines/types.js";
import { parseManifest } from "../../src/core/manifest/io.js";
import { listFiles, tempDir } from "../helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");

let fixtures: string;
let heroJpeg: Buffer;
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "bytecut-snippet-fixtures-"));
  await makeImageFixtures(fixtures);
  // A wide image whose NAME makes the classifier choose the hero preset, kept small to encode fast.
  heroJpeg = await sharp({
    create: { width: 1400, height: 700, channels: 3, background: { r: 30, g: 60, b: 200 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
});
afterAll(() => rm(fixtures, { recursive: true, force: true }));

const cli = (cwd: string, args: string[]) =>
  execFileAsync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), join(repoRoot, "src/cli/index.ts"), ...args],
    { cwd },
  );
const fail = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected the command to fail");
    },
    (e: { code: number; stderr: string; stdout: string }) => e,
  );

async function project(deps: Record<string, string>, opts: { publicDir?: boolean } = {}) {
  const root = await tempDir();
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: deps }));
  const dir = opts.publicDir === false ? "." : "public";
  await mkdir(join(root, dir, "img"), { recursive: true });
  await cp(join(fixtures, "small.jpg"), join(root, dir, "img/small.jpg"));
  await writeFile(join(root, dir, "img/hero.jpg"), heroJpeg);
  return root;
}

async function optimized(deps: Record<string, string>, opts?: { publicDir?: boolean }) {
  const root = await project(deps, opts);
  await cli(root, ["optimize", "-y"]);
  return root;
}

describe("bytecut snippet", () => {
  it("prints JSX for Next.js and the right URLs", async () => {
    const root = await optimized({ next: "15", react: "19" });
    const { stdout } = await cli(root, [
      "snippet",
      "public/img/small.jpg",
      "--alt",
      "A small thing",
    ]);
    expect(stdout).toContain("<picture>");
    expect(stdout).toContain('srcSet="/_bytecut/img/small/small-300.avif 300w"');
    expect(stdout).toContain('src="/_bytecut/img/small/small-300.webp"');
    expect(stdout).toContain('alt="A small thing"');
    expect(stdout).toContain('loading="lazy"');
    expect(stdout).toMatch(/style=\{\{ backgroundColor: "#[0-9a-f]{6}" \}\}/);
    expect(stdout).toContain("/>");
  });

  it("a hero image is a priority image: fetchPriority=high and no lazy loading", async () => {
    const root = await optimized({ next: "15", react: "19" });
    const { stdout } = await cli(root, ["snippet", "public/img/hero.jpg", "--alt", "Hero"]);
    expect(stdout).toContain('fetchPriority="high"');
    expect(stdout).not.toContain("loading=");
  });

  it("--priority and --lazy override the preset", async () => {
    const root = await optimized({ next: "15", react: "19" });
    const forced = (await cli(root, ["snippet", "public/img/small.jpg", "--priority"])).stdout;
    expect(forced).toContain('fetchPriority="high"');
    expect(forced).not.toContain("loading=");
    const lazy = (await cli(root, ["snippet", "public/img/hero.jpg", "--lazy"])).stdout;
    expect(lazy).toContain('fetchPriority="high"');
    expect(lazy).toContain('loading="lazy"');
  });

  it.each([
    ["astro", { astro: "5" }, "html"],
    ["static", {}, "html"],
    ["vite + react", { vite: "6", react: "19" }, "jsx"],
    ["vite + vue", { vite: "6", vue: "3" }, "html"],
  ] as const)("%s uses %s", async (_name, deps, expected) => {
    const root = await optimized({ ...deps });
    const { stdout } = await cli(root, ["snippet", "public/img/small.jpg"]);
    if (expected === "jsx") {
      expect(stdout).toContain("srcSet=");
      expect(stdout).toContain("/>");
    } else {
      expect(stdout).toContain("srcset=");
      expect(stdout).not.toContain("/>");
      expect(stdout).toContain('style="background-color:#');
    }
  });

  it("a static site with no public/ folder serves outputs from its root", async () => {
    const root = await optimized({}, { publicDir: false });
    const { stdout } = await cli(root, ["snippet", "img/small.jpg"]);
    // Static root is the project root, so the mirrored path has no public/ prefix.
    expect(stdout).toContain('srcset="/_bytecut/img/small/small-300.avif 300w"');
    expect(await listFiles(join(root, "_bytecut"))).toContain("bytecut-manifest.json");
  });

  it("--format overrides the framework", async () => {
    const root = await optimized({ next: "15", react: "19" });
    const html = (await cli(root, ["snippet", "public/img/small.jpg", "--format", "html"])).stdout;
    expect(html).toContain("srcset=");
    expect(html).not.toContain("srcSet");
  });

  it("puts only markup on stdout; advice goes to stderr so it can be piped", async () => {
    const root = await optimized({ next: "15", react: "19" });
    const { stdout, stderr } = await cli(root, ["snippet", "public/img/small.jpg"]);
    expect(stdout).not.toMatch(/Note/);
    expect(stdout.trim().startsWith("<picture>")).toBe(true);
    expect(stdout.trim().endsWith("</picture>")).toBe(true);
    expect(stderr).toMatch(/alt text is empty/);
  });

  it("handles several files and --json", async () => {
    const root = await optimized({ next: "15", react: "19" });
    const both = await cli(root, ["snippet", "public/img/small.jpg", "public/img/hero.jpg"]);
    expect(both.stdout.match(/<picture>/g)).toHaveLength(2);

    const { stdout } = await cli(root, ["snippet", "public/img/small.jpg", "--json"]);
    const data = JSON.parse(stdout);
    expect(data).toMatchObject({ version: 1, format: "jsx" });
    expect(data.snippets[0]).toMatchObject({ kind: "image", source: "public/img/small.jpg" });
    expect(data.snippets[0].code).toContain("<picture>");
  });

  it("accepts a path with a leading ./ and escapes odd file names", async () => {
    const root = await project({ next: "15", react: "19" });
    await cp(join(fixtures, "p3.jpg"), join(root, "public/img/my photo #1.jpg"));
    await cli(root, ["optimize", "-y"]);
    const { stdout } = await cli(root, ["snippet", "./public/img/my photo #1.jpg"]);
    expect(stdout).toContain("/_bytecut/img/my%20photo%20%231/my%20photo%20%231-500.webp");
    expect(stdout).not.toContain("my photo");
  });

  describe("errors", () => {
    it("with no manifest, says to optimize first", async () => {
      const root = await project({ next: "15" });
      const e = await fail(cli(root, ["snippet", "public/img/small.jpg"]));
      expect(e.code).toBe(1);
      expect(e.stderr).toMatch(/No manifest .*Run `bytecut optimize -y` first/);
      expect(e.stderr).not.toMatch(/\n\s+at /);
    });

    it("for a file that was not optimized, gives the exact command to run", async () => {
      const root = await optimized({ next: "15" });
      await cp(join(fixtures, "p3.jpg"), join(root, "public/img/new.jpg"));
      const e = await fail(cli(root, ["snippet", "public/img/new.jpg"]));
      expect(e.stderr).toMatch(
        /public\/img\/new\.jpg has not been optimized yet.*bytecut optimize -y public\/img\/new\.jpg/,
      );
    });

    it("with no file, and with a bad --format", async () => {
      const root = await optimized({ next: "15" });
      expect((await fail(cli(root, ["snippet"]))).stderr).toMatch(
        /Name at least one optimized file/,
      );
      const bad = await fail(cli(root, ["snippet", "public/img/small.jpg", "--format", "vue"]));
      expect(bad.stderr).toMatch(/--format must be html or jsx/);
    });
  });
});

describe("placeholders in the manifest", () => {
  const manifestOf = async (root: string, out = "public/_bytecut") =>
    parseManifest(await readFile(join(root, out, "bytecut-manifest.json"), "utf8"));

  function countingEngine() {
    const state = { encodes: 0, placeholders: 0 };
    const engine: ImageEngine = {
      ...sharpImageEngine,
      async encode(input: Buffer, request: EncodeRequest) {
        state.encodes++;
        return sharpImageEngine.encode(input, request);
      },
      async placeholder(input, kind) {
        state.placeholders++;
        return sharpImageEngine.placeholder!(input, kind);
      },
    };
    return { engine, state };
  }

  const run = (root: string, engine: ImageEngine, extra = {}) =>
    optimize({
      projectRoot: root,
      engine,
      toolVersion: "test",
      inputs: ["public"],
      outDir: "public/_bytecut",
      staticRoot: "public",
      execute: true,
      concurrency: 1,
      ...extra,
    });

  it("records a dominant colour by default", async () => {
    const root = await project({ next: "15" });
    await run(root, countingEngine().engine);
    const m = await manifestOf(root);
    for (const entry of Object.values(m.sources)) {
      expect(entry.placeholder).toMatchObject({ kind: "dominant-color" });
      expect(entry.placeholder!.value).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(m.sources["public/img/hero.jpg"]).toMatchObject({ preset: "hero", priority: true });
    expect(m.sources["public/img/small.jpg"]!.priority).toBeUndefined();
  });

  it.each(["lqip", "blurhash"] as const)("can record %s instead", async (kind) => {
    const root = await project({ next: "15" });
    await run(root, countingEngine().engine, { placeholder: kind });
    const m = await manifestOf(root);
    expect(m.sources["public/img/small.jpg"]!.placeholder!.kind).toBe(kind);
    if (kind === "lqip") {
      expect(m.sources["public/img/small.jpg"]!.placeholder!.value).toMatch(
        /^data:image\/webp;base64,/,
      );
    }
  });

  it("changing the kind updates the manifest WITHOUT re-encoding anything", async () => {
    const root = await project({ next: "15" });
    const first = countingEngine();
    await run(root, first.engine);
    expect(first.state.encodes).toBeGreaterThan(0);

    const second = countingEngine();
    await run(root, second.engine, { placeholder: "lqip" });
    expect(second.state.encodes).toBe(0);
    expect(second.state.placeholders).toBeGreaterThan(0);
    const m = await manifestOf(root);
    expect(Object.values(m.sources).every((s) => s.placeholder?.kind === "lqip")).toBe(true);
  });

  it("an unchanged run recomputes nothing and leaves the manifest byte-identical", async () => {
    const root = await project({ next: "15" });
    await run(root, countingEngine().engine);
    const before = await readFile(join(root, "public/_bytecut/bytecut-manifest.json"), "utf8");
    const again = countingEngine();
    await run(root, again.engine);
    expect(again.state.placeholders).toBe(0);
    expect(await readFile(join(root, "public/_bytecut/bytecut-manifest.json"), "utf8")).toBe(
      before,
    );
  });

  it("none removes them, and is stable afterwards", async () => {
    const root = await project({ next: "15" });
    await run(root, countingEngine().engine);
    await run(root, countingEngine().engine, { placeholder: "none" });
    const m = await manifestOf(root);
    expect(Object.values(m.sources).some((s) => s.placeholder)).toBe(false);
    const text = await readFile(join(root, "public/_bytecut/bytecut-manifest.json"), "utf8");
    await run(root, countingEngine().engine, { placeholder: "none" });
    expect(await readFile(join(root, "public/_bytecut/bytecut-manifest.json"), "utf8")).toBe(text);
  });

  it("a changed source gets a fresh placeholder; the old one never survives", async () => {
    const root = await project({ next: "15" });
    await run(root, countingEngine().engine);
    const before = (await manifestOf(root)).sources["public/img/small.jpg"]!.placeholder!.value;

    const inverted = await sharp(join(root, "public/img/small.jpg")).negate().jpeg().toBuffer();
    await writeFile(join(root, "public/img/small.jpg"), inverted);
    await run(root, countingEngine().engine);
    const after = (await manifestOf(root)).sources["public/img/small.jpg"]!.placeholder!.value;
    expect(after).toMatch(/^#[0-9a-f]{6}$/);
    expect(after).not.toBe(before);
  });

  it("skips placeholders for an engine that cannot make them, without failing", async () => {
    const root = await project({ next: "15" });
    const noPlaceholders: ImageEngine = { ...sharpImageEngine };
    delete (noPlaceholders as { placeholder?: unknown }).placeholder;
    await run(root, noPlaceholders);
    const m = await manifestOf(root);
    expect(Object.values(m.sources).every((s) => s.placeholder === undefined)).toBe(true);
  });

  it("the CLI rejects an unknown kind and accepts the known ones", async () => {
    const root = await project({ next: "15" });
    const bad = await fail(cli(root, ["optimize", "--placeholder", "sparkle"]));
    expect(bad.stderr).toMatch(/Unknown placeholder "sparkle"/);
    await cli(root, ["optimize", "-y", "--placeholder", "blurhash"]);
    expect((await manifestOf(root)).sources["public/img/small.jpg"]!.placeholder!.kind).toBe(
      "blurhash",
    );
  });
});

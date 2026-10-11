import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAGE_FIXTURES, makeImageFixtures } from "../../scripts/make-fixtures.js";
import { parseManifest } from "../../src/core/manifest/io.js";
import { hashAll, listFiles, tempDir } from "../helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const OUT = "public/_bytecut";

let fixtures: string;
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "bytecut-jpeg-fixtures-"));
  await makeImageFixtures(fixtures);
});
afterAll(() => rm(fixtures, { recursive: true, force: true }));

const cli = (cwd: string, args: string[]) =>
  execFileAsync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), join(repoRoot, "src/cli/index.ts"), ...args],
    { cwd },
  );

async function project(names: string[], config?: unknown) {
  const root = await tempDir();
  await mkdir(join(root, "public/img"), { recursive: true });
  for (const n of names) await cp(join(fixtures, n), join(root, "public/img", n));
  if (config) await writeFile(join(root, "bytecut.config.json"), JSON.stringify(config));
  return root;
}

const meta = (root: string, rel: string) => sharp(join(root, OUT, rel)).metadata();
const manifestOf = async (root: string) =>
  parseManifest(await readFile(join(root, OUT, "bytecut-manifest.json"), "utf8"));

describe("the default output is a JPEG", () => {
  it("writes one JPEG per image, with metadata stripped, rotation applied and ICC kept", async () => {
    const names = ["photo.jpg", "rotated-exif.jpg", "gps.jpg", "p3.jpg"];
    const root = await project(names);
    const before = await hashAll(join(root, "public/img"), names);
    await cli(root, ["optimize", "-y"]);

    const files = (await listFiles(join(root, OUT))).filter((f) => !f.startsWith(".bytecut-cache"));
    expect(files).toEqual([
      "bytecut-manifest.json",
      "img/gps-700.jpg",
      "img/p3-500.jpg",
      "img/photo-1400.jpg",
      "img/rotated-exif-500.jpg",
    ]);

    const photo = await meta(root, "img/photo-1400.jpg");
    expect(photo.format).toBe("jpeg");
    // mozjpeg writes progressive files: smaller, and a visible sign it was used.
    expect(photo.isProgressive).toBe(true);

    // Stored 800x500 with orientation 6: comes out upright, with no EXIF block left.
    const rotated = await meta(root, "img/rotated-exif-500.jpg");
    expect([rotated.width, rotated.height]).toEqual([500, 800]);
    expect(rotated.exif).toBeUndefined();
    expect((await meta(root, "img/gps-700.jpg")).exif).toBeUndefined();

    // The Display-P3 profile survives (not dropped, not converted).
    const source = await sharp(join(root, "public/img/p3.jpg")).metadata();
    expect((await meta(root, "img/p3-500.jpg")).icc?.equals(source.icc!)).toBe(true);

    expect(await hashAll(join(root, "public/img"), names)).toEqual(before);
    const m = await manifestOf(root);
    expect(m.sources["public/img/photo.jpg"]!.outputs).toMatchObject([
      { format: "jpg", lossless: false, encoder: expect.stringMatching(/^mozjpeg /) },
    ]);
  }, 120_000);

  it("keeps transparency: a PNG with alpha becomes a lossless PNG, not a flattened JPEG", async () => {
    const root = await project(["flat-alpha.png"]);
    // Force the content preset so this checks the alpha rule, not the icon classifier.
    await writeFile(
      join(root, "bytecut.config.json"),
      JSON.stringify({ assets: { "**/flat-alpha.png": "photo" } }),
    );
    await cli(root, ["optimize", "-y"]);
    const files = (await listFiles(join(root, OUT))).filter((f) => f.endsWith(".png"));
    expect(files).toEqual(["img/flat-alpha-600.png"]);
    const out = await meta(root, files[0]!);
    expect(out.format).toBe("png");
    expect(out.hasAlpha).toBe(true);

    // Same pixels, including the alpha channel: this is lossless.
    const read = async (path: string) =>
      (await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data;
    const a = await read(join(root, "public/img/flat-alpha.png"));
    const b = await read(join(root, OUT, files[0]!));
    expect(b.equals(a)).toBe(true);
  }, 120_000);

  it("keeps flat art lossless as PNG at icon sizes", async () => {
    const root = await project(["flat-alpha.png"]);
    const r = await cli(root, ["optimize", "-y"]);
    expect(r.stdout).toBeTruthy();
    const m = await manifestOf(root);
    const outputs = m.sources["public/img/flat-alpha.png"]!.outputs;
    expect(outputs.length).toBeGreaterThan(1);
    expect(outputs.every((o) => o.format === "png" && o.lossless)).toBe(true);
    expect(outputs.every((o) => o.path.endsWith(".png"))).toBe(true);
  }, 120_000);

  it("turns a photographic PNG into a JPEG", async () => {
    const root = await project(["photo-as-png.png"]);
    await cli(root, ["optimize", "-y"]);
    const m = await manifestOf(root);
    const outputs = m.sources["public/img/photo-as-png.png"]!.outputs;
    expect(outputs.map((o) => o.format)).toEqual(["jpg"]);
    expect(outputs[0]!.bytes).toBeLessThan(m.sources["public/img/photo-as-png.png"]!.bytes);
  }, 120_000);

  it("never writes a JPEG that is not smaller than the source (§6.7)", async () => {
    const root = await project([]);
    // Already squeezed: re-encoding at the preset's quality cannot beat it.
    await writeFile(
      join(root, "public/img/tight.jpg"),
      await sharp(join(fixtures, "photo.jpg"))
        .resize({ width: 300 })
        .jpeg({ quality: 20, mozjpeg: true })
        .toBuffer(),
    );
    const r = await cli(root, ["optimize", "-y"]);
    expect(r.stdout).toMatch(/already optimal/);
    expect((await listFiles(join(root, OUT))).filter((f) => f.endsWith(".jpg"))).toEqual([]);
  }, 120_000);

  it("adds webp and avif when the config asks, with the JPEG as the <img> fallback", async () => {
    const root = await project(["small.jpg"], {
      presets: { photo: { formats: ["jpg", "webp", "avif"] } },
    });
    await cli(root, ["optimize", "-y"]);
    const files = (await listFiles(join(root, OUT))).filter((f) => /\.(jpg|webp|avif)$/.test(f));
    expect(files).toEqual(["img/small-300.avif", "img/small-300.jpg", "img/small-300.webp"]);
    const snippet = (await cli(root, ["snippet", "public/img/small.jpg", "--format", "html"]))
      .stdout;
    expect(snippet).toContain("<picture>");
    expect(snippet.indexOf("image/avif")).toBeLessThan(snippet.indexOf("image/webp"));
    // JPEG is the file every browser can show, so it is the <img>.
    expect(snippet).toMatch(/<img src="\/_bytecut\/img\/small-300\.jpg"/);
  }, 180_000);

  it("emits a plain <img> for a JPEG-only result", async () => {
    const root = await project(["small.jpg"]);
    await cli(root, ["optimize", "-y"]);
    const snippet = (await cli(root, ["snippet", "public/img/small.jpg", "--format", "html"]))
      .stdout;
    expect(snippet).not.toContain("<picture>");
    expect(snippet).toContain('src="/_bytecut/img/small-300.jpg"');
  }, 120_000);

  it("honours the configured JPEG quality: lower is smaller", async () => {
    const encode = async (quality: number) => {
      const root = await project(["photo.jpg"], {
        presets: { photo: { quality: { jpg: quality } } },
      });
      await cli(root, ["optimize", "-y"]);
      const out = (await manifestOf(root)).sources["public/img/photo.jpg"]!.outputs[0]!;
      return { quality: out.quality, bytes: out.bytes };
    };
    const low = await encode(40);
    const high = await encode(90);
    expect(low.quality).toBe(40);
    expect(high.quality).toBe(90);
    expect(low.bytes).toBeLessThan(high.bytes);
  }, 120_000);

  it("exposes the fixtures it relies on", () => {
    expect(IMAGE_FIXTURES).toContain("flat-alpha.png");
    expect(IMAGE_FIXTURES).toContain("photo-as-png.png");
  });
});

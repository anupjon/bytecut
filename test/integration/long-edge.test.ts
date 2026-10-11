import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { hashAll, listFiles, tempDir } from "../helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");

/** A smooth gradient: cheap to encode, and every pixel differs so a resize is visible. */
async function jpeg(width: number, height: number): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      data[i] = (x * 255) / width;
      data[i + 1] = (y * 255) / height;
      data[i + 2] = 128;
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

describe("the default size: longest side up to 1920", () => {
  it("makes landscape 1920 wide and portrait 1920 tall, in proportion, never upscaling", async () => {
    const root = await tempDir();
    await mkdir(join(root, "public/img"), { recursive: true });
    await writeFile(join(root, "public/img/land.jpg"), await jpeg(3000, 1500));
    await writeFile(join(root, "public/img/port.jpg"), await jpeg(1500, 3000));
    await writeFile(join(root, "public/img/small-port.jpg"), await jpeg(600, 1000));
    await writeFile(
      join(root, "bytecut.config.json"),
      // Only the formats change; the size is the built-in default under test.
      JSON.stringify({
        presets: { photo: { formats: ["webp"] } },
        assets: { "**/*.jpg": "photo" },
      }),
    );
    const before = await hashAll(join(root, "public/img"), [
      "land.jpg",
      "port.jpg",
      "small-port.jpg",
    ]);

    const r = await execFileAsync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        join(repoRoot, "src/cli/index.ts"),
        "optimize",
        "-y",
      ],
      { cwd: root },
    );
    expect(r.stdout).toContain("land");

    const out = join(root, "public/_bytecut/img");
    expect(await listFiles(out)).toEqual([
      "land-1920.webp",
      "port-960.webp",
      "small-port-600.webp",
    ]);
    const dims = async (rel: string) => {
      const m = await sharp(join(out, rel)).metadata();
      return [m.width, m.height];
    };
    expect(await dims("land-1920.webp")).toEqual([1920, 960]);
    // 1500x3000 portrait: the HEIGHT is 1920, the width follows (960).
    expect(await dims("port-960.webp")).toEqual([960, 1920]);
    // Already within the cap: untouched size.
    expect(await dims("small-port-600.webp")).toEqual([600, 1000]);

    expect(
      await hashAll(join(root, "public/img"), ["land.jpg", "port.jpg", "small-port.jpg"]),
    ).toEqual(before);
  }, 120_000);
});

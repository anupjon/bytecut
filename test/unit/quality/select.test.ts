import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { SafeFs } from "../../../src/core/fs-safe.js";
import { createNativeScorer } from "../../../src/core/quality/native.js";
import { selectScorer } from "../../../src/core/quality/select.js";
import type { RgbImage } from "../../../src/core/quality/types.js";
import { listFiles, tempDir } from "../../helpers.js";

const image = (value: number, side = 16): RgbImage => ({
  data: new Uint8Array(side * side * 3).fill(value),
  width: side,
  height: side,
});
const toPng = async (img: RgbImage) =>
  new Uint8Array(
    await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })
      .png()
      .toBuffer(),
  );

async function fsFor() {
  const root = await tempDir();
  const fs = await SafeFs.create({
    projectRoot: root,
    outDir: join(root, "out"),
    sourceFiles: [],
    sourceDirs: [],
  });
  return { root, fs };
}

const present = (...paths: string[]) => ({ isFile: (p: string) => paths.includes(p) });
const baseOptions = (fs: SafeFs, over: Record<string, unknown> = {}) => ({
  env: {} as Record<string, string | undefined>,
  platform: "linux" as const,
  deps: present(),
  fs,
  toPng,
  run: async () => ({ stdout: "" }),
  ...over,
});

describe("selectScorer", () => {
  it("uses the built-in WebAssembly scorer when no native tool is configured", async () => {
    const { fs } = await fsFor();
    const { scorer, notes } = await selectScorer(baseOptions(fs));
    try {
      expect(scorer.kind).toBe("wasm");
      expect(notes).toEqual([]);
      expect(await scorer.score(image(120), image(120))).toBe(100);
    } finally {
      await scorer.close();
    }
  });

  it.each([
    ["flag", { flag: "/opt/ssim" }, "/opt/ssim"],
    ["env", { env: { BYTECUT_SSIMULACRA2: "/env/ssim" } }, "/env/ssim"],
    ["config", { config: "/cfg/ssim" }, "/cfg/ssim"],
    ["PATH", { env: { PATH: "/usr/local/bin" } }, "/usr/local/bin/ssimulacra2"],
  ])("takes the native tool from the %s", async (_source, over, binary) => {
    const { fs } = await fsFor();
    const { scorer } = await selectScorer(baseOptions(fs, { ...over, deps: present(binary) }));
    expect(scorer.kind).toBe("native");
    expect(scorer.label).toContain(binary);
  });

  it("flag beats env beats config beats PATH", async () => {
    const { fs } = await fsFor();
    const all = present("/f", "/e", "/c", "/p/ssimulacra2");
    const pick = async (over: Record<string, unknown>) =>
      (await selectScorer(baseOptions(fs, { deps: all, env: { PATH: "/p" }, ...over }))).scorer
        .label;
    expect(
      await pick({ flag: "/f", config: "/c", env: { BYTECUT_SSIMULACRA2: "/e", PATH: "/p" } }),
    ).toContain("/f");
    expect(await pick({ config: "/c", env: { BYTECUT_SSIMULACRA2: "/e", PATH: "/p" } })).toContain(
      "/e",
    );
    expect(await pick({ config: "/c" })).toContain("/c");
    expect(await pick({})).toContain("/p/ssimulacra2");
  });

  it("a named path that does not exist falls back to WASM, says so, and ignores PATH", async () => {
    const { fs } = await fsFor();
    const { scorer, notes } = await selectScorer(
      baseOptions(fs, { flag: "/typo/ssim", env: { PATH: "/p" }, deps: present("/p/ssimulacra2") }),
    );
    try {
      expect(scorer.kind).toBe("wasm");
      expect(notes).toEqual([
        "ssimulacra2 not found at /typo/ssim (from flag); using the built-in WebAssembly scorer.",
      ]);
    } finally {
      await scorer.close();
    }
  });
});

describe("native scorer", () => {
  it("hands the tool two PNG files by argument array, parses its output and cleans up", async () => {
    const { root, fs } = await fsFor();
    const seen: Array<{ file: string; args: string[]; pngs: boolean }> = [];
    const scorer = createNativeScorer({
      binary: "/bin/ssimulacra2",
      fs,
      toPng,
      run: async (file, args) => {
        const heads = await Promise.all(
          args.map(async (a) =>
            (await import("node:fs/promises")).readFile(a).then((b) => b.subarray(1, 4).toString()),
          ),
        );
        seen.push({ file, args, pngs: heads.every((h) => h === "PNG") });
        return { stdout: "73.12345678\n" };
      },
    });
    expect(await scorer.score(image(10), image(20))).toBeCloseTo(73.12345678, 8);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ file: "/bin/ssimulacra2", pngs: true });
    expect(seen[0]!.args).toHaveLength(2);
    // Both files lived inside outDir and are gone.
    for (const a of seen[0]!.args) expect(a.startsWith(join(root, "out"))).toBe(true);
    expect(
      (await listFiles(join(root, "out"))).filter((f) => f.endsWith(".tmp") || f.endsWith(".png")),
    ).toEqual([]);
  });

  it("cleans up and reports when the tool fails or prints nonsense", async () => {
    const { root, fs } = await fsFor();
    const failing = createNativeScorer({
      binary: "/bin/ssimulacra2",
      fs,
      toPng,
      run: async () => {
        throw new Error("exit 1");
      },
    });
    await expect(failing.score(image(1), image(2))).rejects.toThrow("exit 1");
    const garbled = createNativeScorer({
      binary: "/b",
      fs,
      toPng,
      run: async () => ({ stdout: "oops" }),
    });
    await expect(garbled.score(image(1), image(2))).rejects.toThrow(/not a score/);
    expect((await listFiles(join(root, "out"))).filter((f) => f.includes("tmp"))).toEqual([]);
  });

  it("never writes outside outDir, whatever it is asked", async () => {
    const { root, fs } = await fsFor();
    await expect(fs.writeTemp("../escape.png", new Uint8Array(1))).rejects.toThrow(
      /Unsafe output path/,
    );
    await mkdir(join(root, "out"), { recursive: true });
    expect(await readdir(root)).toEqual(["out"]);
  });
});

const REAL = process.env.BYTECUT_TEST_SSIMULACRA2;
if (!REAL) {
  console.warn(
    "[bytecut tests] BYTECUT_TEST_SSIMULACRA2 not set: skipping the native ssimulacra2 comparison.",
  );
}
describe.skipIf(!REAL)("native ssimulacra2 (real tool)", () => {
  it("scores a fixture pair the same as the built-in scorer, within the stated tolerance", async () => {
    const dir = join(import.meta.dirname, "../../fixtures/ssimulacra2");
    const rgb = async (f: string): Promise<RgbImage> => {
      const { data, info } = await sharp(join(dir, f))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { data: new Uint8Array(data), width: info.width, height: info.height };
    };
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { fs } = await fsFor();
    const native = createNativeScorer({
      binary: REAL!,
      fs,
      toPng,
      run: async (file, args) => ({ stdout: (await exec(file, args)).stdout }),
    });
    const wasm = (await selectScorer(baseOptions(fs))).scorer;
    try {
      const [ref, dist] = [await rgb("photo-ref.png"), await rgb("photo-jpeg-q50.png")];
      expect(
        Math.abs((await native.score(ref, dist)) - (await wasm.score(ref, dist))),
      ).toBeLessThan(0.1);
    } finally {
      await wasm.close();
    }
  });
});

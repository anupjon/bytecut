import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BytecutError } from "../../../src/core/errors.js";
import { SafeFs } from "../../../src/core/fs-safe.js";
import { listFiles, tempDir } from "../../helpers.js";

async function project() {
  const root = await tempDir();
  const assets = join(root, "assets");
  await mkdir(assets);
  const source = join(assets, "a.jpg");
  await writeFile(source, "src");
  return { root, assets, source, outDir: join(root, "out") };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BytecutError);
  expect((error as BytecutError).code).toBe(code);
}

describe("SafeFs.create (§6.5)", () => {
  it("accepts an outDir beside the sources", async () => {
    const p = await project();
    await expect(
      SafeFs.create({
        projectRoot: p.root,
        outDir: p.outDir,
        sourceFiles: [p.source],
        sourceDirs: [p.assets],
      }),
    ).resolves.toBeInstanceOf(SafeFs);
  });

  it("accepts an outDir nested inside a source folder", async () => {
    const p = await project();
    await expect(
      SafeFs.create({
        projectRoot: p.root,
        outDir: join(p.assets, "_bytecut"),
        sourceFiles: [p.source],
        sourceDirs: [p.assets],
      }),
    ).resolves.toBeInstanceOf(SafeFs);
  });

  it("refuses the project root", async () => {
    const p = await project();
    await expectCode(
      SafeFs.create({ projectRoot: p.root, outDir: p.root, sourceFiles: [], sourceDirs: [] }),
      "UNSAFE_OUT_DIR",
    );
  });

  it("refuses an outDir that contains the project root", async () => {
    const p = await project();
    await expectCode(
      SafeFs.create({
        projectRoot: p.root,
        outDir: join(p.root, ".."),
        sourceFiles: [],
        sourceDirs: [],
      }),
      "UNSAFE_OUT_DIR",
    );
  });

  it("refuses a source folder itself", async () => {
    const p = await project();
    await expectCode(
      SafeFs.create({
        projectRoot: p.root,
        outDir: p.assets,
        sourceFiles: [p.source],
        sourceDirs: [p.assets],
      }),
      "UNSAFE_OUT_DIR",
    );
  });

  it("refuses an outDir containing a source file", async () => {
    const p = await project();
    await expectCode(
      SafeFs.create({
        projectRoot: p.root,
        outDir: p.assets,
        sourceFiles: [p.source],
        sourceDirs: [],
      }),
      "UNSAFE_OUT_DIR",
    );
  });

  it("refuses an outDir that reaches a source through a symlink", async () => {
    const p = await project();
    const link = join(p.root, "link");
    await symlink(p.assets, link);
    await expectCode(
      SafeFs.create({
        projectRoot: p.root,
        outDir: link,
        sourceFiles: [p.source],
        sourceDirs: [p.assets],
      }),
      "UNSAFE_OUT_DIR",
    );
  });
});

describe("SafeFs.writeOutput (§6.2, §6.4)", () => {
  async function safe() {
    const p = await project();
    const fs = await SafeFs.create({
      projectRoot: p.root,
      outDir: p.outDir,
      sourceFiles: [p.source],
      sourceDirs: [p.assets],
    });
    return { ...p, fs };
  }

  it("writes nested outputs inside outDir", async () => {
    const { fs, outDir } = await safe();
    await fs.writeOutput("a/b/c-640.avif", Buffer.from("data"));
    expect(await readFile(join(outDir, "a/b/c-640.avif"), "utf8")).toBe("data");
  });

  it.each([
    "../escape.avif",
    "a/../../escape.avif",
    "/abs/escape.avif",
    "a//b.avif",
    "a\\b.avif",
    "",
  ])("rejects %j", async (path) => {
    const { fs, root } = await safe();
    await expectCode(fs.writeOutput(path, Buffer.from("x")), "UNSAFE_PATH");
    expect(await listFiles(root)).toEqual(["assets/a.jpg"]);
  });

  it("does not follow a directory symlink out of outDir", async () => {
    const { fs, outDir, root } = await safe();
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(outDir);
    await symlink(elsewhere, join(outDir, "escape"));

    await expectCode(fs.writeOutput("escape/x.avif", Buffer.from("x")), "UNSAFE_PATH");
    expect(await listFiles(elsewhere)).toEqual([]);
  });

  it("does not create directories through a symlink to a not-yet-existing target", async () => {
    const { fs, outDir, root } = await safe();
    await mkdir(outDir);
    await symlink(join(root, "missing", "deeper"), join(outDir, "dangling"));
    await expect(fs.writeOutput("dangling/x.avif", Buffer.from("x"))).rejects.toThrow();
    expect(await listFiles(join(root, "missing"))).toEqual([]);
  });

  it("refuses to write through a symlinked output file", async () => {
    const { fs, outDir, source } = await safe();
    await mkdir(outDir);
    await symlink(source, join(outDir, "a.avif"));
    await expectCode(fs.writeOutput("a.avif", Buffer.from("x")), "UNSAFE_PATH");
    expect(await readFile(source, "utf8")).toBe("src");
  });

  it("leaves no temp file behind when the write fails", async () => {
    const { fs, outDir } = await safe();
    // A directory sits where the file should go, so the final rename must fail.
    await mkdir(join(outDir, "blocked.avif"), { recursive: true });
    await expect(fs.writeOutput("blocked.avif", Buffer.from("x"))).rejects.toThrow();
    expect(await listFiles(outDir)).toEqual([]);
  });
});

import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BytecutError } from "../../../src/core/errors.js";
import { writeConfigFile } from "../../../src/core/fs-safe.js";
import { tempDir } from "../../helpers.js";

const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof BytecutError ? error.code : String(error)),
  );

describe("writeConfigFile (the one write outside outDir, §6.2)", () => {
  it("writes a known config file name in the project root, atomically", async () => {
    const root = await tempDir();
    const path = await writeConfigFile(root, "bytecut.config.json", '{ "a": 1 }\n');
    expect(path).toBe(join(root, "bytecut.config.json"));
    expect(await readFile(path, "utf8")).toBe('{ "a": 1 }\n');
    // No temp file is left behind.
    expect(await readdir(root)).toEqual(["bytecut.config.json"]);
  });

  it("replaces an existing file", async () => {
    const root = await tempDir();
    await writeFile(join(root, "bytecut.config.json"), "old");
    await writeConfigFile(root, "bytecut.config.json", "new");
    expect(await readFile(join(root, "bytecut.config.json"), "utf8")).toBe("new");
  });

  it.each([
    "package.json",
    "../bytecut.config.json",
    "sub/bytecut.config.json",
    "/etc/passwd",
    "bytecut.config.yaml",
    ".gitignore",
  ])("refuses any name that is not a config file: %s", async (name) => {
    const root = await tempDir();
    expect(await code(writeConfigFile(root, name, "x"))).toBe("UNSAFE_PATH");
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses to write through a symlink, and leaves its target alone", async () => {
    const root = await tempDir();
    const elsewhere = await tempDir();
    await writeFile(join(elsewhere, "victim.json"), "precious");
    await symlink(join(elsewhere, "victim.json"), join(root, "bytecut.config.json"));
    expect(await code(writeConfigFile(root, "bytecut.config.json", "overwritten"))).toBe(
      "UNSAFE_PATH",
    );
    expect(await readFile(join(elsewhere, "victim.json"), "utf8")).toBe("precious");
  });

  it("writes into the real project folder when the root is itself a symlink", async () => {
    const real = await tempDir();
    const holder = await tempDir();
    await mkdir(join(holder, "x"));
    await symlink(real, join(holder, "link"));
    await writeConfigFile(join(holder, "link"), "bytecut.config.json", "{}");
    expect(await readFile(join(real, "bytecut.config.json"), "utf8")).toBe("{}");
  });
});

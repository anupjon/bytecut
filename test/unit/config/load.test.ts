import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findConfigFiles, loadConfig } from "../../../src/core/config/load.js";
import { tempDir } from "../../helpers.js";

async function withFile(name: string, content: string): Promise<string> {
  const root = await tempDir();
  await writeFile(join(root, name), content);
  return root;
}

const failure = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the load to fail");
};

describe("loadConfig", () => {
  it("returns null with no config: zero-config", async () => {
    expect(await loadConfig(await tempDir())).toBeNull();
  });

  it("loads JSON", async () => {
    const root = await withFile("bytecut.config.json", '{ "outDir": "out", "concurrency": 2 }');
    const loaded = await loadConfig(root);
    expect(loaded).toMatchObject({ name: "bytecut.config.json", format: "json" });
    expect(loaded!.config).toEqual({ outDir: "out", concurrency: 2 });
  });

  it("loads TOML, including nested tables", async () => {
    const root = await withFile(
      "bytecut.config.toml",
      'outDir = "out"\n[assets]\n"public/hero/**" = "hero"\n[budgets]\nmaxFileSize = "100 KB"\n',
    );
    const loaded = await loadConfig(root);
    expect(loaded!.format).toBe("toml");
    expect(loaded!.config.assets).toEqual({ "public/hero/**": "hero" });
    expect(loaded!.config.budgets).toEqual({ maxFileSize: 102_400 });
  });

  it.each([
    ["bytecut.config.mjs", "export default { outDir: 'from-js' };\n", "from-js"],
    [
      "bytecut.config.mts",
      "const c: { outDir: string } = { outDir: 'from-ts' };\nexport default c;\n",
      "from-ts",
    ],
    [
      "bytecut.config.ts",
      "import type { Foo } from './nowhere.ts';\nexport default { outDir: 'typed' } satisfies { outDir: string };\n",
      "typed",
    ],
  ])("loads %s by executing it", async (name, source, outDir) => {
    const loaded = await loadConfig(await withFile(name, source));
    expect(loaded!.config.outDir).toBe(outDir);
  });

  it("accepts a function default export", async () => {
    const root = await withFile(
      "bytecut.config.mjs",
      "export default async () => ({ outDir: 'fn' });\n",
    );
    expect((await loadConfig(root))!.config.outDir).toBe("fn");
  });

  it("explains a config that exports nothing usable", async () => {
    const root = await withFile("bytecut.config.mjs", "export const outDir = 'x';\n");
    expect(await failure(loadConfig(root))).toMatch(/must `export default` a config object/);
  });

  it("reports invalid JSON and invalid TOML with the file name", async () => {
    expect(await failure(loadConfig(await withFile("bytecut.config.json", "{ nope")))).toMatch(
      /^bytecut\.config\.json: is not valid JSON/,
    );
    expect(await failure(loadConfig(await withFile("bytecut.config.toml", "a = = 1")))).toMatch(
      /^bytecut\.config\.toml: is not valid TOML/,
    );
  });

  it("validates after parsing, naming the file", async () => {
    const root = await withFile("bytecut.config.json", '{ "outdir": "x" }');
    expect(await failure(loadConfig(root))).toMatch(
      /bytecut\.config\.json is not a valid bytecut config:\n {2}- \(config\): unknown key "outdir" \(did you mean "outDir"\?\)/,
    );
  });

  it("refuses to choose between two config files", async () => {
    const root = await withFile("bytecut.config.json", "{}");
    await writeFile(join(root, "bytecut.config.toml"), "");
    expect(await findConfigFiles(root)).toEqual(["bytecut.config.json", "bytecut.config.toml"]);
    expect(await failure(loadConfig(root))).toMatch(/More than one config file found/);
    // --config picks one explicitly.
    expect((await loadConfig(root, "bytecut.config.json"))!.name).toBe("bytecut.config.json");
  });

  it("loads --config from any path and errors when it is missing", async () => {
    const root = await tempDir();
    await mkdir(join(root, "conf"));
    await writeFile(join(root, "conf/custom.json"), '{ "outDir": "custom" }');
    expect((await loadConfig(root, "conf/custom.json"))!.config.outDir).toBe("custom");
    expect(await failure(loadConfig(root, "nope.json"))).toMatch(/No such config file: nope\.json/);
  });

  it("ignores a directory that merely has a config-like name", async () => {
    const root = await tempDir();
    await mkdir(join(root, "bytecut.config.json"));
    expect(await findConfigFiles(root)).toEqual([]);
    expect(await loadConfig(root)).toBeNull();
  });

  it("keeps the raw parsed data for later rewriting", async () => {
    const root = await withFile("bytecut.config.json", '{ "assets": { "a.jpg": "icon" } }');
    expect((await loadConfig(root))!.raw).toEqual({ assets: { "a.jpg": "icon" } });
  });

  it("does not follow a symlinked config out of the project silently: it loads what the link points to", async () => {
    // A symlink is the user's own arrangement (shared config); loading it is fine, writing is not.
    const root = await tempDir();
    const other = await tempDir();
    await writeFile(join(other, "shared.json"), '{ "outDir": "shared" }');
    await symlink(join(other, "shared.json"), join(root, "bytecut.config.json"));
    expect((await loadConfig(root))!.config.outDir).toBe("shared");
  });
});

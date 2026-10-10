import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGitIgnored } from "../../../src/core/scan/gitignore.js";
import { tempDir } from "../../helpers.js";

async function project(gitignores: Record<string, string>) {
  const root = await tempDir();
  await mkdir(join(root, "public/_bytecut"), { recursive: true });
  for (const [dir, text] of Object.entries(gitignores)) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, ".gitignore"), text);
  }
  return root;
}

describe("isGitIgnored", () => {
  it("is false without any .gitignore", async () => {
    const root = await project({});
    expect(await isGitIgnored(root, join(root, "public/_bytecut"))).toBe(false);
  });

  it.each([
    ["public/_bytecut", true],
    ["public/_bytecut/", true],
    ["_bytecut", true],
    ["/public/_bytecut", true],
    ["public", true],
    ["*.log", false],
    ["other", false],
    ["/_bytecut", false], // anchored to the root: a different folder
  ])("root pattern %j → %s", async (pattern, expected) => {
    const root = await project({ ".": `${pattern}\n` });
    expect(await isGitIgnored(root, join(root, "public/_bytecut"))).toBe(expected);
  });

  it("honours a nested .gitignore and a later negation", async () => {
    const nested = await project({ public: "_bytecut\n" });
    expect(await isGitIgnored(nested, join(nested, "public/_bytecut"))).toBe(true);

    const negated = await project({ ".": "public/_bytecut\n", public: "!_bytecut\n" });
    expect(await isGitIgnored(negated, join(negated, "public/_bytecut"))).toBe(false);
  });

  it("is false for the project root and for paths outside it", async () => {
    const root = await project({ ".": "*\n" });
    expect(await isGitIgnored(root, root)).toBe(false);
    expect(await isGitIgnored(root, join(root, "..", "elsewhere"))).toBe(false);
  });
});

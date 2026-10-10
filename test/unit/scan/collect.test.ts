import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { collectAssets } from "../../../src/core/scan/collect.js";
import { tempDir } from "../../helpers.js";

async function tree(files: Record<string, string>) {
  const root = await tempDir();
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const rel = (root: string, paths: string[]) =>
  paths.map((p) => relative(root, p).split("\\").join("/"));

async function scan(root: string, inputs: string[], outDir = "out") {
  const r = await collectAssets(inputs, { cwd: root, outDir: join(root, outDir) });
  return { ...r, files: rel(root, r.files), svgs: rel(root, r.svgs), videos: rel(root, r.videos) };
}

describe("collectAssets", () => {
  it("classifies raster, svg and video files", async () => {
    const root = await tree({
      "a/x.jpg": "",
      "a/y.PNG": "",
      "a/z.gif": "",
      "a/logo.svg": "",
      "a/clip.mp4": "",
      "a/notes.txt": "",
    });
    const r = await scan(root, ["a"]);
    expect(r.files).toEqual(["a/x.jpg", "a/y.PNG", "a/z.gif"]);
    expect(r.svgs).toEqual(["a/logo.svg"]);
    expect(r.videos).toEqual(["a/clip.mp4"]);
    expect(r.unsupported).toEqual([]);
  });

  it("reports an explicitly named non-asset as unsupported", async () => {
    const root = await tree({ "a/notes.txt": "" });
    expect((await scan(root, ["a/notes.txt"])).unsupported).toHaveLength(1);
  });

  it("fails clearly for a missing input", async () => {
    const root = await tree({});
    await expect(scan(root, ["nope"])).rejects.toMatchObject({ code: "INPUT_NOT_FOUND" });
  });

  describe(".gitignore (§6.15)", () => {
    it("honours patterns, directory rules and negation", async () => {
      const root = await tree({
        ".gitignore": "*.tmp.jpg\nbuild/\n/only-root.jpg\n!keep.tmp.jpg\n",
        "img/a.jpg": "",
        "img/b.tmp.jpg": "",
        "img/keep.tmp.jpg": "",
        "img/build/c.jpg": "",
        "only-root.jpg": "",
        "img/only-root.jpg": "",
      });
      const r = await scan(root, ["."]);
      expect(r.files).toEqual(["img/a.jpg", "img/keep.tmp.jpg", "img/only-root.jpg"]);
    });

    it("applies nested .gitignore files to their own subtree only", async () => {
      const root = await tree({
        "a/.gitignore": "secret.jpg\n",
        "a/secret.jpg": "",
        "a/ok.jpg": "",
        "b/secret.jpg": "",
      });
      expect((await scan(root, ["."])).files).toEqual(["a/ok.jpg", "b/secret.jpg"]);
    });

    it("lets a deeper file un-ignore what a shallower one ignored", async () => {
      const root = await tree({
        ".gitignore": "*.jpg\n",
        "a/.gitignore": "!wanted.jpg\n",
        "a/wanted.jpg": "",
        "a/other.jpg": "",
      });
      expect((await scan(root, ["."])).files).toEqual(["a/wanted.jpg"]);
    });

    it("applies the root .gitignore when only a subfolder is scanned", async () => {
      const root = await tree({
        ".gitignore": "drafts/\n*.psd.jpg\n",
        "public/img/a.jpg": "",
        "public/img/x.psd.jpg": "",
        "public/drafts/d.jpg": "",
      });
      expect((await scan(root, ["public"])).files).toEqual(["public/img/a.jpg"]);
    });

    it("applies intermediate .gitignore files when scanning a deep folder", async () => {
      const root = await tree({
        "public/.gitignore": "private/\n",
        "public/img/private/p.jpg": "",
        "public/img/private-ish.jpg": "",
        "public/private/q.jpg": "",
      });
      const r = await scan(root, ["public/img"]);
      expect(r.files).toEqual(["public/img/private-ish.jpg"]);
    });

    it("does not let .gitignore veto a file that is named explicitly", async () => {
      const root = await tree({ ".gitignore": "*.jpg\n", "a.jpg": "" });
      expect((await scan(root, ["a.jpg"])).files).toEqual(["a.jpg"]);
      expect((await scan(root, ["."])).files).toEqual([]);
    });
  });

  it("never descends into node_modules, .git or the output folder", async () => {
    const root = await tree({
      "node_modules/p/a.jpg": "",
      ".git/x.jpg": "",
      "out/old.jpg": "",
      "src/a/node_modules/b.jpg": "",
      "keep.jpg": "",
    });
    expect((await scan(root, ["."])).files).toEqual(["keep.jpg"]);
  });

  it("does not follow symlinks", async () => {
    const root = await tree({ "real/a.jpg": "" });
    const outside = await tree({ "secret.jpg": "" });
    await symlink(outside, join(root, "link-dir"));
    await symlink(join(outside, "secret.jpg"), join(root, "link.jpg"));
    expect((await scan(root, ["."])).files).toEqual(["real/a.jpg"]);
  });

  it("de-duplicates files reached through overlapping inputs", async () => {
    const root = await tree({ "a/x.jpg": "" });
    expect((await scan(root, ["a", "a/x.jpg", "."])).files).toEqual(["a/x.jpg"]);
  });

  it("records the folders given as inputs", async () => {
    const root = await tree({ "a/x.jpg": "" });
    const r = await collectAssets(["a"], { cwd: root, outDir: join(root, "out") });
    expect(r.sourceDirs).toEqual([join(root, "a")]);
  });
});

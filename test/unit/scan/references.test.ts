import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanReferences } from "../../../src/core/scan/references.js";
import { tempDir } from "../../helpers.js";

async function scan(files: Record<string, string>) {
  const root = await tempDir();
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return scanReferences({ cwd: root, outDir: join(root, "out") });
}

describe("scanReferences", () => {
  it("extracts image basenames from html, css, js and markdown", async () => {
    const r = await scan({
      "index.html": '<img src="/img/Hero.JPG"> <img srcset="a-640.webp 640w, a-1280.avif 1280w">',
      "src/s.css": "a { background: url('../img/bg.png') } b { background: url(icon.svg) }",
      "src/m.ts": 'import x from "./pics/photo.jpeg"; const y = `/anim/${n}.gif`;',
      "docs/readme.md": "![alt](images/shot.webp)",
    });
    expect([...r.names].sort()).toEqual([
      "a-1280.avif",
      "a-640.webp",
      "bg.png",
      "hero.jpg",
      "icon.svg",
      "photo.jpeg",
      "shot.webp",
    ]);
    expect(r.filesScanned).toBe(4);
    expect(r.truncated).toBe(false);
  });

  it("decodes percent-escapes and keeps only the final path segment", async () => {
    const r = await scan({ "a.html": '<img src="/my%20images/Sunset%20Pic.png">' });
    expect([...r.names]).toEqual(["sunset pic.png"]);
  });

  it("does not see dynamic references (documented limitation)", async () => {
    const r = await scan({
      "a.js": "const src = `/img/${name}.jpg`; load('/img/' + id + '.png');",
    });
    expect([...r.names]).toEqual([]);
  });

  it("skips lockfiles, binary-ish extensions, ignored folders and node_modules", async () => {
    const r = await scan({
      "package-lock.json": '{"resolved":"x/locked.png"}',
      "pic.png": "pretend binary mentioning fake.png",
      ".gitignore": "private/\n",
      "private/a.html": '<img src="private.png">',
      "node_modules/p/i.js": 'require("dep.png")',
      "ok.html": '<img src="seen.png">',
    });
    expect([...r.names]).toEqual(["seen.png"]);
  });
});

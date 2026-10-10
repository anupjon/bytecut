import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeImageFixtures } from "../../scripts/make-fixtures.js";
import { sharpImageEngine } from "../../src/core/engines/image.js";
import { svgoEngine } from "../../src/core/engines/svg.js";
import type { EncodeRequest, ImageEngine } from "../../src/core/engines/types.js";
import { sha256 } from "../../src/core/hash.js";
import { parseManifest } from "../../src/core/manifest/io.js";
import { optimize } from "../../src/core/commands/optimize.js";
import { createSession } from "../../src/tui/session.js";
import { hashAll, listFiles, tempDir } from "../helpers.js";
import { KEY, mount, project } from "./harness.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const OUT = "public/_bytecut";
let templateDir: string;
beforeAll(async () => {
  templateDir = await mkdtemp(join(tmpdir(), "bytecut-tui-fixtures-"));
  await makeImageFixtures(templateDir);
  return () => rm(templateDir, { recursive: true, force: true });
});

let current: ReturnType<typeof mount> | undefined;
afterEach(() => current?.unmount());

/** A Next.js-shaped project with several small photos. */
async function nextProject(count = 5): Promise<string> {
  const root = await tempDir();
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15" } }));
  await mkdir(join(root, "public/img"), { recursive: true });
  for (let i = 0; i < count; i++) {
    // Distinct bytes per file so none is a cache hit or duplicate of another.
    const data = await sharp(join(templateDir, "photo.jpg"))
      .resize(900 + i * 20)
      .modulate({ brightness: 1 + i * 0.05 })
      .jpeg({ quality: 85 })
      .toBuffer();
    await writeFile(join(root, "public/img", `p${i}.jpg`), data);
  }
  await cp(join(templateDir, "small.jpg"), join(root, "public/img/small.jpg"));
  return root;
}

/** Real engine whose encodes take a while, so there is something to cancel. */
function slowEngine(delayMs: number, onEncode?: () => void): ImageEngine {
  return {
    ...sharpImageEngine,
    async encode(input: Buffer, request: EncodeRequest) {
      onEncode?.();
      await new Promise((r) => setTimeout(r, delayMs));
      return sharpImageEngine.encode(input, request);
    },
  };
}

function sessionFor(root: string, engine: ImageEngine) {
  return createSession({
    projectRoot: root,
    engine,
    svgEngine: svgoEngine,
    project,
    inputs: ["public"],
    toolVersion: "test",
    ffmpeg: { found: true, installHint: "" },
    concurrency: 1,
  });
}

describe("TUI against the real session", () => {
  it("scans, reviews and writes real files through the whole flow", async () => {
    const root = await nextProject(2);
    const before = await hashAll(
      join(root, "public/img"),
      await listFiles(join(root, "public/img")),
    );

    current = mount(sessionFor(root, sharpImageEngine), (props) => <App3 {...props} />);
    await current.waitFor((f) => f.includes("p0.jpg"), "the list", 15_000);
    expect(current.frame()).toMatch(/3 of 3 files selected/);

    await current.press(KEY.enter);
    await current.waitFor((f) => f.includes("Review:"), "the review", 15_000);
    await current.press(KEY.enter);
    await current.waitFor((f) => f.includes("Done"), "the results", 30_000);
    expect(current.frame()).toMatch(/files? written/);

    const outputs = await listFiles(join(root, OUT));
    expect(outputs).toContain("bytecut-manifest.json");
    expect(outputs.some((f) => f.startsWith("img/p0/") && f.endsWith(".avif"))).toBe(true);
    // Sources are untouched (§6.1).
    expect(await hashAll(join(root, "public/img"), Object.keys(before))).toEqual(before);
  });

  it("cancelling mid-run leaves no partial files and a manifest that matches the disk", async () => {
    const root = await nextProject(5);
    let encodes = 0;
    current = mount(
      sessionFor(
        root,
        slowEngine(120, () => encodes++),
      ),
      (props) => <App3 {...props} />,
    );
    await current.waitFor((f) => f.includes("p0.jpg"), "the list", 15_000);
    await current.press(KEY.enter);
    await current.waitFor((f) => f.includes("Review:"), "the review", 15_000);
    // The scan's trial encodes use the engine too; count only what the run itself does.
    const scanEncodes = encodes;
    await current.press(KEY.enter);

    // Let a few encodes complete, then cancel while work is in flight.
    const start = Date.now();
    while (encodes - scanEncodes < 3 && Date.now() - start < 15_000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(encodes - scanEncodes).toBeGreaterThanOrEqual(3);
    await current.press(KEY.esc);
    await current.waitFor((f) => f.includes("Cancelled"), "the cancelled screen", 15_000);
    expect(current.frame()).toContain("no partial files were left behind");

    const all = await listFiles(join(root, OUT));
    // §6.4: nothing truncated or half-written is left in outDir.
    expect(all.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const written = all.filter((f) => /\.(avif|webp)$/.test(f));
    expect(written.length).toBeGreaterThan(0);
    expect(written.length).toBeLessThan(5 * 6 + 2); // genuinely stopped early

    // Every output on disk is complete and decodable.
    for (const f of written) {
      const meta = await sharp(join(root, OUT, f)).metadata();
      expect(meta.width).toBeGreaterThan(0);
    }
    // The manifest lists exactly what is on disk, with matching hashes (§6.3, §6.6).
    const manifest = parseManifest(
      await readFile(join(root, OUT, "bytecut-manifest.json"), "utf8"),
    );
    const listed = Object.values(manifest.sources).flatMap((s) =>
      s.outputs.filter((o) => o.sha256),
    );
    expect(listed.map((o) => o.path).sort()).toEqual(written.sort());
    for (const o of listed) {
      expect(sha256(await readFile(join(root, OUT, o.path)))).toBe(o.sha256);
    }
  });

  it("a run after a cancel finishes the rest without warnings", async () => {
    const root = await nextProject(3);
    let encodes = 0;
    current = mount(
      sessionFor(
        root,
        slowEngine(100, () => encodes++),
      ),
      (props) => <App3 {...props} />,
    );
    await current.waitFor((f) => f.includes("p0.jpg"), "the list", 15_000);
    await current.press(KEY.enter);
    await current.waitFor((f) => f.includes("Review:"), "the review", 15_000);
    const scanEncodes = encodes;
    await current.press(KEY.enter);
    while (encodes - scanEncodes < 2) await new Promise((r) => setTimeout(r, 20));
    await current.press(KEY.esc);
    await current.waitFor((f) => f.includes("Cancelled"), "cancel", 15_000);
    current.unmount();

    // Resume with the headless pipeline against the same folder.
    const outcome = await optimize({
      projectRoot: root,
      engine: sharpImageEngine,
      toolVersion: "test",
      inputs: ["public"],
      outDir: OUT,
      staticRoot: "public",
      execute: true,
    });
    expect(outcome.result!.warnings).toEqual([]);
    expect(outcome.result!.items.every((i) => i.status === "done" || i.status === "cached")).toBe(
      true,
    );
    expect(outcome.findings.filter((f) => f.ruleId === "project/stale-output")).toEqual([]);
  });

  it("per-file preset overrides survive a rescan, so an optimized file stays 'done'", async () => {
    const root = await nextProject(1);
    current = mount(sessionFor(root, sharpImageEngine), (props) => <App3 {...props} />);
    await current.waitFor((f) => f.includes("p0.jpg"), "the list", 15_000);
    await current.press("p"); // photo → hero
    await current.waitFor((f) => /p0\.jpg.*hero\*/.test(f), "the override");
    await current.press(KEY.enter);
    await current.waitFor((f) => f.includes("Review:"), "the review", 15_000);
    await current.press(KEY.enter);
    await current.waitFor((f) => f.includes("Done"), "the results", 30_000);
    await current.press(KEY.enter);
    await current.waitFor(
      (f) => f.includes("already optimized") || f.includes("Nothing to optimize"),
      "the rescan",
      15_000,
    );
    // photo.jpg-sized p0 is covered under the override; it must not reappear as work to do.
    expect(current.frame()).not.toMatch(/\[x\] .*p0\.jpg/);
  });
});

// The harness mounts <App> itself; this alias keeps the call sites above short.
import { App } from "../../src/tui/app.js";
const App3 = App;

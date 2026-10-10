import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasFfmpeg, makeImageFixtures, makeVideoFixtures } from "../../scripts/make-fixtures.js";
import { sharpImageEngine } from "../../src/core/engines/image.js";
import { svgoEngine } from "../../src/core/engines/svg.js";
import type { EncodeRequest, ImageEngine } from "../../src/core/engines/types.js";
import { sha256 } from "../../src/core/hash.js";
import { parseManifest } from "../../src/core/manifest/io.js";
import { optimize } from "../../src/core/commands/optimize.js";
import { createSession } from "../../src/tui/session.js";
import { createFfmpegVideoEngine } from "../../src/core/video/ffmpeg-engine.js";
import { isFile, run as runBinary } from "../../src/cli/system.js";
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
    // The preset change is news to the config, so the run ends with the save question.
    await current.waitFor((f) => f.includes("Save these choices"), "the save prompt");
    await current.press("n");
    await current.waitFor((f) => !f.includes("Save these choices"), "the prompt to close");
    expect(await listFiles(root)).not.toContain("bytecut.config.json");
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

const FFMPEG = await hasFfmpeg();
if (!FFMPEG) console.warn("[bytecut tests] ffmpeg not found: skipping TUI video tests.");

describe.skipIf(!FFMPEG)("TUI with a real video", () => {
  it("lists a video, plans it, and writes AV1 + H.264 + poster", async () => {
    const videos = await mkdtemp(join(tmpdir(), "bytecut-tui-video-"));
    await makeVideoFixtures(videos);
    const root = await tempDir();
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15" } }));
    await mkdir(join(root, "public/media"), { recursive: true });
    await cp(join(videos, "heavy.mp4"), join(root, "public/media/heavy.mp4"));
    await rm(videos, { recursive: true, force: true });

    const videoEngine = createFfmpegVideoEngine({
      env: process.env,
      platform: process.platform,
      deps: { isFile },
      run: runBinary,
    });
    const session = createSession({
      projectRoot: root,
      engine: sharpImageEngine,
      svgEngine: svgoEngine,
      project,
      inputs: ["public"],
      toolVersion: "test",
      ffmpeg: { found: true, installHint: "" },
      videoEngine,
      needsFfmpeg: "install ffmpeg",
    });

    current = mount(session, (props) => <App3 {...props} />);
    await current.waitFor((f) => f.includes("heavy.mp4"), "the video row", 60_000);
    expect(current.frame()).toMatch(/\[x\] .*heavy\.mp4/);
    expect(current.frame()).toContain("content-video");

    await current.press(KEY.enter);
    await current.waitFor((f) => f.includes("Review:"), "the review", 30_000);
    expect(current.frame()).toMatch(/heavy\.mp4.*content-video · 3 outputs/);

    await current.press(KEY.enter);
    await current.waitFor((f) => f.includes("Done"), "the results", 120_000);
    // The results screen is one line per file plus totals; the outputs are checked on disk.
    expect(current.frame()).toMatch(/heavy\.mp4.*content-video/);
    expect(current.frame()).toMatch(/Total: 3 files written/);

    const out = await listFiles(join(root, "public/_bytecut"));
    expect(out).toEqual(
      expect.arrayContaining([
        "media/heavy/heavy-320.av1.mp4",
        "media/heavy/heavy-320.h264.mp4",
        "media/heavy/heavy-poster.avif",
        "bytecut-manifest.json",
      ]),
    );
  }, 240_000);

  it("shows a video as skipped with the install command when ffmpeg is missing", async () => {
    const videos = await mkdtemp(join(tmpdir(), "bytecut-tui-video-"));
    await makeVideoFixtures(videos);
    const root = await tempDir();
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15" } }));
    await mkdir(join(root, "public/media"), { recursive: true });
    await cp(join(videos, "heavy.mp4"), join(root, "public/media/heavy.mp4"));
    await cp(join(templateDir, "photo.jpg"), join(root, "public/media/photo.jpg"));
    await rm(videos, { recursive: true, force: true });

    const session = createSession({
      projectRoot: root,
      engine: sharpImageEngine,
      svgEngine: svgoEngine,
      project,
      inputs: ["public"],
      toolVersion: "test",
      ffmpeg: { found: false, installHint: "apt install ffmpeg" },
      videoEngine: createFfmpegVideoEngine({
        ffmpegFlag: "/nonexistent/ffmpeg",
        env: process.env,
        platform: process.platform,
        deps: { isFile },
        run: runBinary,
      }),
      needsFfmpeg: "install ffmpeg with: apt install ffmpeg",
    });

    current = mount(session, (props) => <App3 {...props} />);
    await current.waitFor((f) => f.includes("photo.jpg"), "the list", 60_000);
    // The image is offered; the video is shown as skipped with what to install.
    expect(current.frame()).toContain("skipped public/media/heavy.mp4: needs ffmpeg");
    expect(current.frame()).toContain("install ffmpeg with: apt install ffmpeg");
    expect(current.frame()).not.toMatch(/\[.\] .*heavy\.mp4/);
  }, 120_000);
});

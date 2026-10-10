import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasFfmpeg, makeVideoFixtures } from "../../scripts/make-fixtures.js";
import { audit } from "../../src/core/commands/audit.js";
import { optimize } from "../../src/core/commands/optimize.js";
import { sharpImageEngine } from "../../src/core/engines/image.js";
import { svgoEngine } from "../../src/core/engines/svg.js";
import { sha256File } from "../../src/core/hash.js";
import { parseManifest } from "../../src/core/manifest/io.js";
import { isFastStart } from "../../src/core/video/probe.js";
import { AbortedError, createFfmpegVideoEngine } from "../../src/core/video/ffmpeg-engine.js";
import { buildEncodeArgs } from "../../src/core/video/args.js";
import { listFiles, tempDir } from "../helpers.js";
import { isFile, run } from "../../src/cli/system.js";

const execFileAsync = promisify(execFile);
const FFMPEG = await hasFfmpeg();
if (!FFMPEG) {
  // Visible, not silent (§8): CI installs ffmpeg, so these must run there.
  console.warn("[bytecut tests] ffmpeg not found: skipping real-video integration tests.");
}
const suite = FFMPEG ? describe : describe.skip;

const OUT = "public/_bytecut";
let fixtures: string;

beforeAll(async () => {
  if (!FFMPEG) return;
  fixtures = await mkdtemp(join(tmpdir(), "bytecut-video-fixtures-"));
  await makeVideoFixtures(fixtures);
});
afterAll(async () => {
  if (fixtures) await rm(fixtures, { recursive: true, force: true });
});

async function project(names: string[]): Promise<string> {
  const root = await tempDir();
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15" } }));
  await mkdir(join(root, "public/media"), { recursive: true });
  for (const n of names) await cp(join(fixtures, n), join(root, "public/media", n));
  return root;
}

function realEngine(flags: { ffmpeg?: string; ffprobe?: string } = {}) {
  return createFfmpegVideoEngine({
    ffmpegFlag: flags.ffmpeg,
    ffprobeFlag: flags.ffprobe,
    env: process.env,
    platform: process.platform,
    deps: { isFile },
    run,
  });
}

async function probeFile(path: string) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    path,
  ]);
  const j = JSON.parse(stdout) as {
    streams: Array<{
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      pix_fmt?: string;
    }>;
    format: { duration: string };
  };
  const v = j.streams.find((s) => s.codec_type === "video")!;
  const [n, d] = (v.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    codec: v.codec_name,
    width: v.width!,
    height: v.height!,
    fps: n! / d!,
    pixFmt: v.pix_fmt,
    hasAudio: j.streams.some((s) => s.codec_type === "audio"),
    duration: Number(j.format.duration),
  };
}

function runOptimize(root: string, engine = realEngine(), outDir = OUT, extra = {}) {
  return optimize({
    projectRoot: root,
    engine: sharpImageEngine,
    toolVersion: "test",
    inputs: ["public"],
    outDir,
    staticRoot: "public",
    execute: true,
    videoEngine: engine,
    needsFfmpeg: "install ffmpeg",
    ...extra,
  });
}

suite("video pipeline with real ffmpeg (M5)", () => {
  it("produces AV1 and H.264 MP4s plus a poster, verified with ffprobe", async () => {
    const root = await project(["heavy.mp4"]);
    const sourceHash = await sha256File(join(root, "public/media/heavy.mp4"));
    const outcome = await runOptimize(root);

    const v = outcome.result!.videos![0]!;
    expect(v.preset).toBe("content-video");
    expect(v.outputs.map((o) => [o.role, o.codec ?? "-", o.status])).toEqual([
      ["video", "av1", "written"],
      ["video", "h264", "written"],
      ["poster", "-", "written"],
    ]);

    const dir = join(root, OUT, "media/heavy");
    const av1 = await probeFile(join(dir, "heavy-320.av1.mp4"));
    const h264 = await probeFile(join(dir, "heavy-320.h264.mp4"));
    expect(av1).toMatchObject({
      codec: "av1",
      width: 320,
      height: 240,
      pixFmt: "yuv420p",
      hasAudio: true,
    });
    expect(h264).toMatchObject({
      codec: "h264",
      width: 320,
      height: 240,
      pixFmt: "yuv420p",
      hasAudio: true,
    });
    expect(av1.duration).toBeCloseTo(3, 0);
    expect(av1.fps).toBe(30);

    // faststart: moov precedes mdat (the §M5 acceptance check).
    expect(await isFastStart(join(dir, "heavy-320.av1.mp4"))).toBe(true);
    expect(await isFastStart(join(dir, "heavy-320.h264.mp4"))).toBe(true);

    // Poster is a real AVIF with the video's dimensions.
    const { default: sharp } = await import("sharp");
    const poster = await sharp(join(dir, "heavy-poster.avif")).metadata();
    expect(poster).toMatchObject({ width: 320, height: 240, compression: "av1" });

    // Smaller than the source, which is the point.
    const src = (await stat(join(root, "public/media/heavy.mp4"))).size;
    expect((await stat(join(dir, "heavy-320.av1.mp4"))).size).toBeLessThan(src);
    // The source is untouched (§6.1).
    expect(await sha256File(join(root, "public/media/heavy.mp4"))).toBe(sourceHash);
  });

  it("strips audio and caps frame rate for a backdrop (background-video)", async () => {
    const root = await project(["heavy-60fps.mp4"]);
    const outcome = await runOptimize(root);
    expect(outcome.result!.videos![0]!.preset).toBe("background-video");
    const h264 = await probeFile(join(root, OUT, "media/heavy-60fps/heavy-60fps-320.h264.mp4"));
    expect(h264.hasAudio).toBe(false);
    expect(h264.fps).toBe(30); // 60 → capped
    expect(h264.duration).toBeCloseTo(2, 0);
  });

  it("keeps the audio track for content", async () => {
    const root = await project(["heavy.mp4"]);
    await runOptimize(root);
    const a = await probeFile(join(root, OUT, "media/heavy/heavy-320.h264.mp4"));
    expect(a.hasAudio).toBe(true);
  });

  it("converts an animated GIF to silent looping video", async () => {
    const root = await project(["loop.gif"]);
    const outcome = await runOptimize(root);
    const v = outcome.result!.videos![0]!;
    expect(v.preset).toBe("gif-to-video");
    const written = v.outputs.filter((o) => o.status === "written");
    expect(written.map((o) => o.role).sort()).toContain("poster");
    const av1 = v.outputs.find((o) => o.codec === "av1")!;
    if (av1.status === "written") {
      const p = await probeFile(join(root, OUT, av1.path));
      expect(p).toMatchObject({ codec: "av1", width: 160, height: 120, hasAudio: false });
    }
    // The GIF was removed from the image plan: it is not also processed as a still image.
    expect(outcome.plan.items.map((i) => i.source)).not.toContain("public/media/loop.gif");
  });

  it("never writes a file larger than the source (§6.7)", async () => {
    // silent.mp4 is already efficient, so AV1/H.264 re-encodes are not smaller.
    const root = await project(["silent.mp4"]);
    const outcome = await runOptimize(root);
    const sourceBytes = (await stat(join(root, "public/media/silent.mp4"))).size;
    for (const o of outcome.result!.videos![0]!.outputs.filter((x) => x.role === "video")) {
      if (o.status === "written") expect(o.bytes).toBeLessThan(sourceBytes);
      else expect(o.status).toBe("already-optimal");
    }
    for (const f of await listFiles(join(root, OUT))) {
      if (f.endsWith(".mp4")) {
        expect((await stat(join(root, OUT, f))).size).toBeLessThan(sourceBytes);
      }
    }
  });

  it("is byte-for-byte deterministic across runs (§6.12)", async () => {
    const root = await project(["heavy.mp4"]);
    await runOptimize(root, realEngine(), "out-a");
    await runOptimize(root, realEngine(), "out-b");
    const names = (await listFiles(join(root, "out-a"))).filter((f) => /\.(mp4|avif)$/.test(f));
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) {
      expect(await sha256File(join(root, "out-a", name)), name).toBe(
        await sha256File(join(root, "out-b", name)),
      );
    }
  });

  it("a second run encodes nothing and leaves the manifest identical", async () => {
    const root = await project(["heavy.mp4"]);
    await runOptimize(root);
    const manifest = await readFile(join(root, OUT, "bytecut-manifest.json"), "utf8");
    let encodes = 0;
    const engine = realEngine();
    const real = engine.encode.bind(engine);
    engine.encode = async (...args) => {
      encodes++;
      return real(...args);
    };
    const second = await runOptimize(root, engine);
    expect(encodes).toBe(0);
    expect(second.result!.videos![0]!.status).toBe("cached");
    expect(await readFile(join(root, OUT, "bytecut-manifest.json"), "utf8")).toBe(manifest);
  });

  it("records the exact codec string, which matches the file and appears in the snippet", async () => {
    const root = await project(["heavy.mp4"]);
    await runOptimize(root);
    const m = parseManifest(await readFile(join(root, OUT, "bytecut-manifest.json"), "utf8"));
    const entry = m.videos["public/media/heavy.mp4"]!;
    const { readVideoCodecString } = await import("../../src/core/video/codecs.js");
    const { buildSnippet } = await import("../../src/core/snippets/build.js");

    for (const out of entry.outputs.filter((o) => o.role === "video")) {
      const fromFile = await readVideoCodecString(join(root, OUT, out.path));
      expect(fromFile).not.toBeNull();
      // Audio was kept (content-video), so AAC-LC is appended.
      expect(out.codecs).toBe(`${fromFile}, mp4a.40.2`);
    }
    const av1 = entry.outputs.find((o) => o.codec === "av1")!;
    expect(av1.codecs).toMatch(/^av01\.0\.\d\d[MH]\.08, mp4a\.40\.2$/);
    const h264 = entry.outputs.find((o) => o.codec === "h264")!;
    expect(h264.codecs).toMatch(/^avc1\.[0-9a-f]{6}, mp4a\.40\.2$/);

    const snippet = buildSnippet(
      m,
      { source: "public/media/heavy.mp4", originalUrl: "/media/heavy.mp4" },
      { format: "html" },
    )!;
    expect(snippet.code).toContain(`codecs="${av1.codecs}"`);
    expect(snippet.code).toContain(`codecs="${h264.codecs}"`);
    // AV1 before H.264, so a browser that can play AV1 takes it and others fall through.
    expect(snippet.code.indexOf(av1.codecs!)).toBeLessThan(snippet.code.indexOf(h264.codecs!));
  });

  it("records a placeholder for a video, made from its poster", async () => {
    const root = await project(["heavy.mp4"]);
    await runOptimize(root);
    const m = parseManifest(await readFile(join(root, OUT, "bytecut-manifest.json"), "utf8"));
    expect(m.videos["public/media/heavy.mp4"]!.placeholder).toMatchObject({
      kind: "dominant-color",
    });
    expect(m.videos["public/media/heavy.mp4"]!.placeholder!.value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("records the encoder and parameters per output in the manifest", async () => {
    const root = await project(["heavy.mp4"]);
    await runOptimize(root);
    const m = parseManifest(await readFile(join(root, OUT, "bytecut-manifest.json"), "utf8"));
    expect(m.version).toBe(3);
    const entry = m.videos["public/media/heavy.mp4"]!;
    expect(entry).toMatchObject({ preset: "content-video", width: 320, height: 240 });
    const av1 = entry.outputs.find((o) => o.codec === "av1")!;
    expect(av1).toMatchObject({
      role: "video",
      format: "mp4",
      crf: 32,
      speed: "6",
      audio: "keep",
      url: "/_bytecut/media/heavy/heavy-320.av1.mp4",
      status: "written",
    });
    expect(av1.encoder).toMatch(/^libsvtav1 \(ffmpeg [\d.]+/);
    expect(av1.sha256).toBe(await sha256File(join(root, OUT, av1.path)));
  });
});

suite("cancel with real ffmpeg (§M5: cancel kills ffmpeg and cleans up)", () => {
  async function pgrep(pattern: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-f", pattern]);
      return stdout.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  it("aborting an encode kills the process promptly and it never finishes the file", async () => {
    const engine = realEngine();
    const probe = (await engine.probe(join(fixtures, "big.mp4")))!;
    const output = join(await tempDir(), `.cancel-me-${process.pid}.tmp`);
    const controller = new AbortController();

    const started = Date.now();
    const encoding = engine.encode(
      {
        source: join(fixtures, "big.mp4"),
        output,
        encoder: "libsvtav1",
        crf: 20,
        speed: "2", // deliberately slow so there is something to cancel
        maxWidth: null,
        maxFps: null,
        audio: "strip",
        audioBitrate: "96k",
        probe,
      },
      () => undefined,
      controller.signal,
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(await pgrep(output)).not.toHaveLength(0); // really running
    controller.abort();

    await expect(encoding).rejects.toBeInstanceOf(AbortedError);
    expect(Date.now() - started).toBeLessThan(8_000);
    // No ffmpeg left behind with our output path on its command line.
    expect(await pgrep(output)).toEqual([]);
  }, 30_000);

  it("through the executor: no output, no temp file, a cancelled result", async () => {
    const root = await project(["heavy.mp4"]);
    const controller = new AbortController();
    const engine = realEngine();
    const real = engine.encode.bind(engine);
    engine.encode = async (request, onProgress, signal) => {
      setTimeout(() => controller.abort(), 150);
      return real(
        { ...request, speed: request.encoder === "libsvtav1" ? "1" : request.speed },
        onProgress,
        signal,
      );
    };
    const outcome = await runOptimize(root, engine, OUT, { signal: controller.signal });
    expect(outcome.result!.cancelled).toBe(true);
    const files = await listFiles(join(root, OUT));
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(files.filter((f) => f.endsWith(".mp4"))).toEqual([]);
  }, 30_000);
});

suite("degradation with real binaries (§4)", () => {
  /** A stand-in `ffmpeg` that reports no AV1 encoders but otherwise runs the real one. */
  async function noAv1Ffmpeg(): Promise<string> {
    const dir = await tempDir();
    const real = (await execFileAsync("sh", ["-c", "command -v ffmpeg"])).stdout.trim();
    const script = join(dir, "ffmpeg");
    await writeFile(
      script,
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("-encoders")) {
  const r = spawnSync(${JSON.stringify(real)}, args, { encoding: "utf8", maxBuffer: 1 << 26 });
  process.stdout.write(r.stdout.split("\\n").filter((l) => !/libsvtav1|libaom-av1|librav1e/.test(l)).join("\\n"));
  process.exit(r.status ?? 0);
}
const r = spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
`,
    );
    await chmod(script, 0o755);
    return script;
  }

  it.skipIf(process.platform === "win32")(
    "no AV1 encoder: H.264 and the poster are produced and the AV1 skip is reported",
    async () => {
      const root = await project(["heavy.mp4"]);
      const ffprobe = (await execFileAsync("sh", ["-c", "command -v ffprobe"])).stdout.trim();
      const engine = realEngine({ ffmpeg: await noAv1Ffmpeg(), ffprobe });
      expect((await engine.capabilities())!.libsvtav1).toBe(false);

      const outcome = await runOptimize(root, engine);
      const v = outcome.result!.videos![0]!;
      expect(v.outputs.map((o) => [o.codec ?? o.role, o.status])).toEqual([
        ["av1", "unavailable"],
        ["h264", "written"],
        ["poster", "written"],
      ]);
      expect(outcome.result!.warnings.join("\n")).toMatch(/AV1 encoder not available/);
      expect(outcome.notes.join("\n")).toMatch(/No AV1 encoder.*AV1 outputs will be skipped/);

      const files = await listFiles(join(root, OUT, "media/heavy"));
      expect(files).toEqual(["heavy-320.h264.mp4", "heavy-poster.avif"]);
      expect((await probeFile(join(root, OUT, "media/heavy/heavy-320.h264.mp4"))).codec).toBe(
        "h264",
      );

      // And it does not keep trying: the next run is cached, not a re-encode.
      let encodes = 0;
      const real = engine.encode.bind(engine);
      engine.encode = async (...a) => {
        encodes++;
        return real(...a);
      };
      const again = await runOptimize(root, engine);
      expect(encodes).toBe(0);
      expect(again.result!.videos![0]!.status).toBe("cached");
    },
  );

  it("no ffmpeg: videos are reported as needing it, images still work", async () => {
    const root = await project(["heavy.mp4", "loop.gif"]);
    await cp(
      join(process.cwd(), "test/fixtures/images/small.jpg"),
      join(root, "public/media/small.jpg"),
    );
    const engine = realEngine({ ffmpeg: "/nonexistent/ffmpeg" });
    expect(await engine.capabilities()).toBeNull();

    const outcome = await runOptimize(root, engine, OUT, {
      needsFfmpeg: "install ffmpeg with: sudo apt install ffmpeg",
    });
    const videos = outcome.result!.videos!;
    expect(videos.map((v) => v.status)).toEqual(["skipped", "skipped"]);
    expect(videos.every((v) => v.reason?.startsWith("needs ffmpeg"))).toBe(true);
    expect(outcome.notes.join("\n")).toMatch(
      /ffmpeg not found: 2 video files cannot be processed \(install ffmpeg with: sudo apt install ffmpeg\)/,
    );

    // The image went through untouched by the missing ffmpeg.
    const files = await listFiles(join(root, OUT));
    expect(files.some((f) => f.startsWith("media/small/") && f.endsWith(".avif"))).toBe(true);
    expect(files.some((f) => f.endsWith(".mp4"))).toBe(false);
    // Nothing about the videos is recorded as done.
    const m = parseManifest(await readFile(join(root, OUT, "bytecut-manifest.json"), "utf8"));
    expect(m.videos).toEqual({});
  });

  it("no ffmpeg in audit: listed with the install command, never skipped silently", async () => {
    const root = await project(["heavy.mp4", "loop.gif"]);
    const report = await audit({
      projectRoot: root,
      engine: sharpImageEngine,
      svgEngine: svgoEngine,
      inputs: ["public"],
      outDir: OUT,
      staticRoot: "public",
      ffmpeg: { found: false, installHint: "brew install ffmpeg" },
      videoEngine: realEngine({ ffmpeg: "/nonexistent/ffmpeg" }),
      needsFfmpeg: "install ffmpeg with: brew install ffmpeg",
      persistCache: false,
    });
    expect(report.unprobed.map((u) => u.source).sort()).toEqual([
      "public/media/heavy.mp4",
      "public/media/loop.gif",
    ]);
    expect(report.counts.videos).toBe(2);
    expect(report.notes.join(" ")).toMatch(
      /2 video files need ffmpeg to be analysed: install ffmpeg with: brew install ffmpeg/,
    );
    const gif = report.findings.find((f) => f.ruleId === "gif/animated")!;
    expect(gif.message).toMatch(/Needs ffmpeg: brew install ffmpeg/);
  });
});

suite("video audit with real ffmpeg", () => {
  async function auditOf(names: string[]) {
    const root = await project(names);
    return audit({
      projectRoot: root,
      engine: sharpImageEngine,
      svgEngine: svgoEngine,
      inputs: ["public"],
      outDir: OUT,
      staticRoot: "public",
      ffmpeg: { found: true, installHint: "" },
      videoEngine: realEngine(),
      persistCache: false,
    });
  }

  it("finds the issues the fixtures were built to have", async () => {
    const report = await auditOf([
      "with-audio.mp4",
      "faststart.mp4",
      "heavy-60fps.mp4",
      "big.mp4",
      "loop.gif",
    ]);
    const hits = new Set(report.findings.map((f) => `${f.ruleId}:${f.source?.split("/").pop()}`));
    // moov after mdat only in the non-faststart ones.
    expect(hits.has("video/no-faststart:with-audio.mp4")).toBe(true);
    expect(hits.has("video/no-faststart:faststart.mp4")).toBe(false);
    // a silent 60 fps clip is a backdrop, so the cap applies.
    expect(hits.has("video/high-fps:heavy-60fps.mp4")).toBe(true);
    // 2560 wide, silent: capped to 1920.
    expect(hits.has("video/oversized-resolution:big.mp4")).toBe(true);
    // the GIF is estimated with a real trial encode.
    const gif = report.findings.find((f) => f.ruleId === "gif/animated")!;
    expect(gif.estimated).toBeGreaterThan(0);
    expect(report.counts.videos).toBe(5);
  }, 120_000);

  it("estimates a long video from samples and lands near the real output", async () => {
    const root = await project(["long.mp4"]);
    const engine = realEngine();
    const report = await audit({
      projectRoot: root,
      engine: sharpImageEngine,
      svgEngine: svgoEngine,
      inputs: ["public"],
      outDir: OUT,
      staticRoot: "public",
      ffmpeg: { found: true, installHint: "" },
      videoEngine: engine,
      persistCache: false,
    });
    const file = report.files.find((f) => f.source.endsWith("long.mp4"))!;
    expect(file.estimatedBytes).not.toBeNull();

    // Compare with what optimize would really write for the best output.
    const outcome = await runOptimize(root, engine, "real-out", { force: true });
    const outputs = outcome.result!.videos![0]!.outputs.filter(
      (o) => o.role === "video" && o.bytes > 0,
    );
    const actual = Math.min(...outputs.map((o) => o.bytes));
    const error = (file.estimatedBytes! - actual) / actual;
    console.info(
      `video estimate: ~${file.estimatedBytes} bytes vs actual ${actual} (${(error * 100).toFixed(1)}%), 8 s sampled`,
    );
    expect(Math.abs(error)).toBeLessThanOrEqual(0.35);
  }, 120_000);
});

suite("argument safety (§6.14)", () => {
  it("a hostile file name stays one argv element", () => {
    const evil = "/p/a; rm -rf ~ `x` $(y).mp4";
    const args = buildEncodeArgs({
      source: evil,
      output: "/o/.t.tmp",
      encoder: "libx264",
      crf: 23,
      speed: "slow",
      maxWidth: null,
      maxFps: null,
      audio: "strip",
      audioBitrate: "96k",
      probe: {
        durationSec: 1,
        width: 640,
        height: 360,
        fps: 30,
        videoCodec: "h264",
        pixelFormat: null,
        bitrate: null,
        hasAudio: false,
        audioCodec: null,
        container: "mp4",
      },
    });
    expect(args.filter((a) => a === evil)).toHaveLength(1);
    expect(args[args.indexOf("-i") + 1]).toBe(evil);
  });
});

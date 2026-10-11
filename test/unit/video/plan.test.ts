import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildVideoItems, plannedVideoOutputs } from "../../../src/core/plan/video.js";
import { CONTENT_VIDEO_PRESET, BACKGROUND_VIDEO_PRESET } from "../../../src/core/presets/video.js";
import { tempDir } from "../../helpers.js";
import { fakeVideoEngine, probeOf } from "../../video-helpers.js";

async function project(files: Record<string, string>) {
  const root = await tempDir();
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const abs = (root: string, rel: string) => join(root, rel);

describe("plannedVideoOutputs", () => {
  it("names videos by width and codec, with a poster, mirrored from the static root", () => {
    const out = plannedVideoOutputs(
      "public/media/clip.mp4",
      "public",
      CONTENT_VIDEO_PRESET,
      probeOf({ width: 1280, height: 720 }),
    );
    expect(out.map((o) => o.path)).toEqual([
      "media/clip-1280.av1.mp4",
      "media/clip-1280.h264.mp4",
      "media/clip-poster.avif",
    ]);
    expect(out.map((o) => o.role)).toEqual(["video", "video", "poster"]);
  });

  it("caps width by the preset, rounds to even, and never upscales", () => {
    const widthOf = (w: number, preset = BACKGROUND_VIDEO_PRESET) =>
      plannedVideoOutputs("a.mp4", ".", preset, probeOf({ width: w }))[0]!.width;
    expect(widthOf(3840)).toBe(1920);
    expect(widthOf(1281)).toBe(1280);
    expect(widthOf(640)).toBe(640);
    expect(widthOf(3840, CONTENT_VIDEO_PRESET)).toBe(3840); // content keeps resolution
  });

  it("carries the resolved parameters into every output", () => {
    const [av1, h264, poster] = plannedVideoOutputs("a.mp4", ".", CONTENT_VIDEO_PRESET, probeOf());
    expect(av1).toMatchObject({
      codec: "av1",
      crf: 32,
      speed: "6",
      audio: "keep",
      audioBitrate: "128k",
      maxWidth: null,
    });
    expect(h264).toMatchObject({ codec: "h264", crf: 23, speed: "slow" });
    expect(poster).toMatchObject({ role: "poster", format: "avif", at: 0.1 });
  });
});

describe("buildVideoItems", () => {
  const common = (root: string, over = {}) => ({
    projectRoot: root,
    staticRoot: ".",
    needsFfmpeg: "install ffmpeg with: apt install ffmpeg",
    ...over,
  });

  it("probes, classifies, plans, and sorts by path", async () => {
    const root = await project({ "b/clip.mp4": "BBB", "a/loop.mp4": "AAA" });
    const { engine } = fakeVideoEngine({
      probes: {
        "clip.mp4": probeOf({ hasAudio: true, durationSec: 60 }),
        "loop.mp4": probeOf({ hasAudio: false, durationSec: 5 }),
      },
    });
    const items = await buildVideoItems({
      ...common(root),
      files: [abs(root, "b/clip.mp4"), abs(root, "a/loop.mp4")],
      engine,
    });
    expect(items.map((i) => [i.source, i.preset])).toEqual([
      ["a/loop.mp4", "background-video"],
      ["b/clip.mp4", "content-video"],
    ]);
    expect(items[0]).toMatchObject({ sourceBytes: 3, sourceWidth: 1280, hasAudio: false });
    expect(items[0]!.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(items[0]!.classification?.reason).toMatch(/silent/);
  });

  it("plans animated GIFs with the gif-to-video preset", async () => {
    const root = await project({ "m/spin.gif": "GIF" });
    const { engine } = fakeVideoEngine({
      defaultProbe: probeOf({ hasAudio: false, videoCodec: "gif" }),
    });
    const [item] = await buildVideoItems({
      ...common(root),
      files: [abs(root, "m/spin.gif")],
      engine,
    });
    expect(item).toMatchObject({
      preset: "gif-to-video",
      classification: { reason: "animated GIF" },
    });
    expect(item!.outputs[0]!.path).toBe("m/spin-1280.av1.mp4");
  });

  it("lists every file as 'needs ffmpeg' with the install text when there is no engine", async () => {
    const root = await project({ "a.mp4": "A", "b.gif": "B" });
    const items = await buildVideoItems({
      ...common(root),
      files: [abs(root, "a.mp4"), abs(root, "b.gif")],
      engine: null,
    });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.skip?.reason).toBe("needs ffmpeg: install ffmpeg with: apt install ffmpeg");
      expect(item.outputs).toEqual([]);
      expect(item.sourceSha256).toMatch(/^[0-9a-f]{64}$/); // still hashed, never silently dropped
    }
  });

  it("treats an engine whose ffmpeg is missing the same as no engine", async () => {
    const root = await project({ "a.mp4": "A" });
    const { engine, calls } = fakeVideoEngine({ caps: null });
    const [item] = await buildVideoItems({ ...common(root), files: [abs(root, "a.mp4")], engine });
    expect(item!.skip?.reason).toMatch(/^needs ffmpeg/);
    expect(calls.probes).toEqual([]);
  });

  it("skips unreadable files and files with no video stream, with distinct reasons", async () => {
    const root = await project({ "bad.mp4": "x", "audio.mp4": "y" });
    const { engine } = fakeVideoEngine({
      probes: { "bad.mp4": null, "audio.mp4": probeOf({ width: 0, height: 0 }) },
    });
    const items = await buildVideoItems({
      ...common(root),
      files: [abs(root, "audio.mp4"), abs(root, "bad.mp4")],
      engine,
    });
    expect(items.map((i) => i.skip?.reason)).toEqual(["no video stream", "no video stream"]);

    const throwing = fakeVideoEngine().engine;
    throwing.probe = async () => {
      throw new Error("ffprobe exploded");
    };
    const [item] = await buildVideoItems({
      ...common(root),
      files: [abs(root, "bad.mp4")],
      engine: throwing,
    });
    expect(item!.skip?.reason).toBe("could not be read by ffprobe");
  });

  it("a per-file override wins over the classifier, and only for video presets", async () => {
    const root = await project({ "a.mp4": "A" });
    const { engine } = fakeVideoEngine();
    const [forced] = await buildVideoItems({
      ...common(root),
      files: [abs(root, "a.mp4")],
      engine,
      presetOverrides: { "a.mp4": "background-video" },
    });
    expect(forced).toMatchObject({
      preset: "background-video",
      classification: { reason: "set to background-video for this file" },
    });
    const [ignored] = await buildVideoItems({
      ...common(root),
      files: [abs(root, "a.mp4")],
      engine,
      presetOverrides: { "a.mp4": "icon" },
    });
    expect(ignored!.preset).toBe("content-video");
  });

  it("refuses sources outside the project and colliding output paths", async () => {
    const root = await project({ "a.mp4": "A", "a.gif": "G" });
    const { engine } = fakeVideoEngine();
    await expect(
      buildVideoItems({ ...common(root), files: ["/elsewhere/x.mp4"], engine }),
    ).rejects.toMatchObject({ code: "SOURCE_OUTSIDE_PROJECT" });

    // a.mp4 and a.gif both want a-1280.* names in the same directory.
    await expect(
      buildVideoItems({ ...common(root), files: [abs(root, "a.mp4"), abs(root, "a.gif")], engine }),
    ).rejects.toMatchObject({ code: "OUTPUT_COLLISION" });
  });

  it("detects a collision with an image output that is already claimed", async () => {
    const root = await project({ "a.mp4": "A" });
    const { engine } = fakeVideoEngine();
    await expect(
      buildVideoItems({
        ...common(root),
        files: [abs(root, "a.mp4")],
        engine,
        claimed: new Set(["a-poster.avif"]),
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_COLLISION" });
  });

  it("mirrors relative to the static root", async () => {
    const root = await project({ "public/v/a.mp4": "A" });
    const { engine } = fakeVideoEngine();
    const [item] = await buildVideoItems({
      ...common(root, { staticRoot: "public" }),
      files: [abs(root, "public/v/a.mp4")],
      engine,
    });
    expect(item!.outputs[0]!.path).toBe("v/a-1280.av1.mp4");
  });

  it("uses the probe callback (so callers can cache by hash)", async () => {
    const root = await project({ "a.mp4": "A" });
    const { engine, calls } = fakeVideoEngine();
    const seen: string[] = [];
    await buildVideoItems({
      ...common(root),
      files: [abs(root, "a.mp4")],
      engine,
      async probe(path, sha) {
        seen.push(sha);
        return probeOf({ width: 640 });
      },
    });
    expect(seen).toHaveLength(1);
    expect(calls.probes).toEqual([]);
  });
});

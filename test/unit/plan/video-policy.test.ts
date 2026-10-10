import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../../../src/core/config/presets.js";
import { matchesGlob } from "../../../src/core/config/glob.js";
import { buildVideoItems } from "../../../src/core/plan/video.js";
import type { PresetPolicy } from "../../../src/core/presets/catalog.js";
import { fakeVideoEngine, probeOf } from "../../video-helpers.js";
import { tempDir } from "../../helpers.js";

function policy(
  presets: Parameters<typeof buildCatalog>[0],
  assets: Record<string, string>,
): PresetPolicy {
  const catalog = buildCatalog(presets);
  const rules = Object.entries(assets).map(([pattern, preset]) => ({ pattern, preset }));
  return { catalog, assetFor: (s) => rules.find((r) => matchesGlob(r.pattern, s)) };
}

async function plan(name: string, p?: PresetPolicy, probe = probeOf()) {
  const root = await tempDir();
  await writeFile(join(root, name), "not really a video");
  const { engine } = fakeVideoEngine({ defaultProbe: probe });
  const [item] = await buildVideoItems({
    files: [join(root, name)],
    projectRoot: root,
    engine,
    needsFfmpeg: "install ffmpeg",
    ...(p ? { policy: p } : {}),
  });
  return item!;
}

describe("video presets from config", () => {
  it("an assets rule picks a custom video preset, and its settings reach the outputs", async () => {
    const p = policy(
      { mute: { extends: "content-video", audio: "strip", maxWidth: 640, codecs: ["h264"] } },
      { "*.mp4": "mute" },
    );
    const item = await plan("promo.mp4", p, probeOf({ width: 1920, height: 1080 }));
    expect(item.preset).toBe("mute");
    expect(item.classification?.reason).toBe('set to mute by assets "*.mp4"');
    const videos = item.outputs.filter((o) => o.role === "video");
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({ codec: "h264", width: 640, audio: "strip", maxWidth: 640 });
  });

  it("changing a built-in video preset changes what the classifier's verdict produces", async () => {
    const p = policy({ "content-video": { target: "low" } }, {});
    const baseline = await plan("talk.mp4");
    const changed = await plan("talk.mp4", p);
    expect(baseline.preset).toBe("content-video");
    expect(changed.preset).toBe("content-video");
    const crf = (i: typeof baseline) =>
      (i.outputs.find((o) => (o as { codec?: string }).codec === "av1") as { crf: number }).crf;
    expect(crf(changed)).toBe(crf(baseline) + 4);
  });

  it("ignores an assets rule that names an image preset for a video file", async () => {
    const p = policy({}, { "*.mp4": "icon" });
    const item = await plan("clip.mp4", p);
    expect(item.preset).not.toBe("icon");
    expect(item.classification?.reason).not.toMatch(/assets/);
  });

  it("a per-file override still beats an assets rule", async () => {
    const root = await tempDir();
    await writeFile(join(root, "clip.mp4"), "x");
    const { engine } = fakeVideoEngine();
    const [item] = await buildVideoItems({
      files: [join(root, "clip.mp4")],
      projectRoot: root,
      engine,
      needsFfmpeg: "install ffmpeg",
      presetOverrides: { "clip.mp4": "background-video" },
      policy: policy({}, { "*.mp4": "content-video" }),
    });
    expect(item!.preset).toBe("background-video");
  });
});

import { describe, expect, it } from "vitest";
import { orphanedOutput } from "../../../src/core/audit/rules/orphaned-output.js";
import { staleOutput } from "../../../src/core/audit/rules/stale-output.js";
import type { ProjectContext } from "../../../src/core/audit/types.js";
import type {
  Manifest,
  ManifestVideoOutput,
  ManifestVideoSource,
} from "../../../src/core/manifest/types.js";
import type { PlannedVideoOutput, VideoPlanItem } from "../../../src/core/plan/types.js";

const H = "a".repeat(64);
const F = "b".repeat(64);

const av1: PlannedVideoOutput = {
  role: "video",
  path: "m/a/a-1280.av1.mp4",
  codec: "av1",
  width: 1280,
  crf: 32,
  speed: "6",
  maxWidth: null,
  maxFps: null,
  audio: "keep",
  audioBitrate: "128k",
};
const h264: PlannedVideoOutput = {
  ...av1,
  path: "m/a/a-1280.h264.mp4",
  codec: "h264",
  crf: 23,
  speed: "slow",
};

const item: VideoPlanItem = {
  source: "m/a.mp4",
  sourceBytes: 1000,
  sourceSha256: H,
  sourceWidth: 1280,
  sourceHeight: 720,
  durationSec: 3,
  fps: 30,
  hasAudio: true,
  videoCodec: "h264",
  preset: "content-video",
  outputs: [av1, h264],
};

const rec = (o: PlannedVideoOutput, encoder: string): ManifestVideoOutput => ({
  path: o.path,
  url: `/_bytecut/${o.path}`,
  role: "video",
  format: "mp4",
  codec: o.codec,
  width: 1280,
  height: 720,
  bytes: 500,
  sha256: F,
  crf: o.crf,
  speed: o.speed,
  maxWidth: null,
  maxFps: null,
  audio: "keep",
  encoder,
  status: "written",
});

const entry = (over: Partial<ManifestVideoSource> = {}): ManifestVideoSource => ({
  sha256: H,
  bytes: 1000,
  width: 1280,
  height: 720,
  durationSec: 3,
  preset: "content-video",
  outputs: [rec(av1, "libsvtav1 (ffmpeg 6.1.1)"), rec(h264, "libx264 (ffmpeg 6.1.1)")],
  ...over,
});

const manifest = (videos: Manifest["videos"]): Manifest => ({
  version: 3,
  tools: {},
  publicPath: "/_bytecut",
  sources: {},
  videos,
});

function ctx(over: Partial<ProjectContext> = {}): ProjectContext {
  return {
    plan: { version: 1, outDir: "out", publicPath: "/_bytecut", items: [], videos: [item] },
    manifest: manifest({ "m/a.mp4": entry() }),
    encoders: { avif: "x", webp: "y" },
    videoEncoders: { av1: "libsvtav1 (ffmpeg 6.1.1)", h264: "libx264 (ffmpeg 6.1.1)" },
    sourceExists: async () => true,
    outputHash: async () => F,
    ...over,
  };
}

describe("project/stale-output for videos", () => {
  it("is quiet when everything is current", async () => {
    expect(await staleOutput.check(ctx())).toEqual([]);
  });

  it("reports a changed source, a missing file and a modified file", async () => {
    const changed = ctx({ manifest: manifest({ "m/a.mp4": entry({ sha256: "c".repeat(64) }) }) });
    expect((await staleOutput.check(changed))[0]!.message).toMatch(/source changed/);

    const missing = await staleOutput.check(ctx({ outputHash: async () => null }));
    expect(missing[0]!.message).toMatch(/output file is missing/);

    const modified = await staleOutput.check(ctx({ outputHash: async () => "d".repeat(64) }));
    expect(modified[0]!.message).toMatch(/modified.*unless you use --force/);
  });

  it("reports a preset change as outputs differing", async () => {
    const f = await staleOutput.check(
      ctx({ manifest: manifest({ "m/a.mp4": entry({ preset: "background-video" }) }) }),
    );
    expect(f[0]!.message).toMatch(/preset or widths differ/);
  });

  it("flags an encoder that differs from the one installed now, without promising regeneration", async () => {
    const m = manifest({
      "m/a.mp4": entry({
        outputs: [rec(av1, "libaom-av1 (ffmpeg 5.1)"), rec(h264, "libx264 (ffmpeg 6.1.1)")],
      }),
    });
    const f = await staleOutput.check(ctx({ manifest: m }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ path: av1.path });
    expect(f[0]!.message).toBe(
      "encoded with libaom-av1 (ffmpeg 5.1), installed is libsvtav1 (ffmpeg 6.1.1); run with --force to regenerate",
    );
  });

  it("does not report drift when the installed encoder is unknown", async () => {
    const m = manifest({
      "m/a.mp4": entry({ outputs: [rec(av1, "something else"), rec(h264, "else")] }),
    });
    expect(await staleOutput.check(ctx({ manifest: m, videoEncoders: {} }))).toEqual([]);
  });

  it("does not count an AV1 output that cannot be made here as missing", async () => {
    const withoutAv1 = manifest({
      "m/a.mp4": entry({ outputs: [rec(h264, "libx264 (ffmpeg 6.1.1)")] }),
    });
    const bad = await staleOutput.check(ctx({ manifest: withoutAv1 }));
    expect(bad[0]!.message).toMatch(/preset or widths differ/);
    const ok = await staleOutput.check(
      ctx({ manifest: withoutAv1, unavailableCodecs: new Set(["av1"]) }),
    );
    expect(ok).toEqual([]);
  });

  it("ignores plan-skipped videos", async () => {
    const skipped = { ...item, skip: { reason: "needs ffmpeg" }, outputs: [] };
    const c = ctx({
      plan: { version: 1, outDir: "o", publicPath: "/_bytecut", items: [], videos: [skipped] },
      manifest: manifest({ "m/a.mp4": entry({ sha256: "c".repeat(64) }) }),
    });
    expect(await staleOutput.check(c)).toEqual([]);
  });
});

describe("project/orphaned-output for videos", () => {
  it("reports outputs of a source that no longer exists", async () => {
    const f = await orphanedOutput.check(
      ctx({
        plan: { version: 1, outDir: "o", publicPath: "/_bytecut", items: [] },
        sourceExists: async () => false,
      }),
    );
    expect(f.map((x) => x.path).sort()).toEqual([av1.path, h264.path].sort());
    expect(f.every((x) => x.message === "source no longer exists" && x.severity === "info")).toBe(
      true,
    );
  });

  it("reports outputs the current preset no longer produces", async () => {
    const extra = rec({ ...av1, path: "m/a/a-1920.av1.mp4" }, "libsvtav1 (ffmpeg 6.1.1)");
    const m = manifest({ "m/a.mp4": entry({ outputs: [...entry().outputs, extra] }) });
    const f = await orphanedOutput.check(ctx({ manifest: m }));
    expect(f.map((x) => x.path)).toEqual(["m/a/a-1920.av1.mp4"]);
  });

  it("does not judge videos outside this run's plan when the file still exists", async () => {
    const f = await orphanedOutput.check(
      ctx({ plan: { version: 1, outDir: "o", publicPath: "/_bytecut", items: [] } }),
    );
    expect(f).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { parsePlan, serializePlan } from "../../../src/core/plan/schema.js";
import type { Plan } from "../../../src/core/plan/types.js";

const plan: Plan = {
  version: 1,
  outDir: "public/_bytecut",
  publicPath: "/_bytecut",
  items: [
    {
      source: "assets/a.jpg",
      sourceBytes: 100,
      sourceSha256: "a".repeat(64),
      sourceWidth: 800,
      sourceHeight: 600,
      preset: "photo",
      outputs: [
        {
          path: "assets/a-640.avif",
          format: "avif",
          width: 640,
          lossless: false,
          quality: 60,
          effort: 4,
        },
      ],
    },
  ],
};

const clone = () => structuredClone(plan);

describe("plan schema", () => {
  it("round-trips through serialize and parse", () => {
    expect(parsePlan(serializePlan(plan))).toEqual(plan);
  });

  it("serializes with a trailing newline", () => {
    expect(serializePlan(plan).endsWith("}\n")).toBe(true);
  });

  it("allows an outDir outside the project (validated later by SafeFs)", () => {
    expect(() => parsePlan(JSON.stringify({ ...plan, outDir: "../shared/out" }))).not.toThrow();
  });

  const mutations: Array<[string, (p: Plan) => void]> = [
    ["a source with ..", (p) => (p.items[0]!.source = "../secret.jpg")],
    ["an absolute source", (p) => (p.items[0]!.source = "/etc/passwd")],
    ["a Windows drive source", (p) => (p.items[0]!.source = "C:/x.jpg")],
    ["a backslash source", (p) => (p.items[0]!.source = "a\\b.jpg")],
    ["an output with ..", (p) => (p.items[0]!.outputs[0]!.path = "../x.avif")],
    ["an absolute outDir", (p) => (p.outDir = "/tmp/out")],
    ["a bad hash", (p) => (p.items[0]!.sourceSha256 = "xyz")],
    ["a bad format", (p) => ((p.items[0]!.outputs[0] as { format: string }).format = "gif")],
    ["a wrong version", (p) => ((p as { version: number }).version = 2)],
    ["duplicate output paths", (p) => p.items.push({ ...p.items[0]!, source: "assets/b.jpg" })],
  ];

  it.each(mutations)("rejects %s", (_name, mutate) => {
    const bad = clone();
    mutate(bad);
    expect(() => parsePlan(JSON.stringify(bad))).toThrowError(/not a valid bytecut plan/);
  });

  it("rejects unknown fields and non-JSON", () => {
    expect(() => parsePlan(JSON.stringify({ ...plan, extra: true }))).toThrow();
    expect(() => parsePlan("not json", "my.json")).toThrowError(/my\.json is not valid JSON/);
  });
});

describe("plan schema: search", () => {
  const searched = () => {
    const p = clone();
    p.items[0]!.outputs[0]!.search = {
      metric: "ssimulacra2",
      target: 80,
      floor: 60,
      maxBytes: 120000,
    };
    return p;
  };

  it("round-trips an output with a perceptual target", () => {
    expect(parsePlan(serializePlan(searched()))).toEqual(searched());
  });

  it("rejects an unknown metric, an out-of-range target and stray keys", () => {
    for (const search of [
      { metric: "vmaf", target: 90 },
      { metric: "ssimulacra2", target: 0 },
      { metric: "ssimulacra2", target: 101 },
      { metric: "ssimulacra2", target: 80, maxBytes: -1 },
      { metric: "ssimulacra2", target: 80, extra: true },
    ]) {
      const p = clone() as unknown as { items: Array<{ outputs: Array<Record<string, unknown>> }> };
      p.items[0]!.outputs[0]!.search = search;
      expect(() => parsePlan(JSON.stringify(p))).toThrow();
    }
  });
});

describe("plan schema: video search", () => {
  const videoPlan = (search?: unknown) =>
    ({
      ...clone(),
      items: [],
      videos: [
        {
          source: "m/a.mp4",
          sourceBytes: 1000,
          sourceSha256: "a".repeat(64),
          sourceWidth: 1280,
          sourceHeight: 720,
          durationSec: 10,
          fps: 30,
          hasAudio: false,
          videoCodec: "h264",
          preset: "background-video",
          outputs: [
            {
              role: "video",
              path: "m/a-1280.h264.mp4",
              codec: "h264",
              width: 1280,
              crf: 28,
              speed: "slow",
              maxWidth: null,
              maxFps: null,
              audio: "strip",
              audioBitrate: "96k",
              ...(search === undefined ? {} : { search }),
            },
          ],
        },
      ],
    }) as unknown as Plan;

  it("round-trips a video output with a target", () => {
    for (const search of [
      { metric: "vmaf", target: 93 },
      { metric: "ssimulacra2", target: 70 },
    ]) {
      expect(parsePlan(serializePlan(videoPlan(search)))).toEqual(videoPlan(search));
    }
  });

  it("rejects an unknown metric, an out-of-range target and stray keys", () => {
    for (const search of [
      { metric: "psnr", target: 40 },
      { metric: "vmaf", target: 0 },
      { metric: "vmaf", target: 101 },
      { metric: "vmaf", target: 90, floor: 70 },
    ]) {
      expect(() => parsePlan(JSON.stringify(videoPlan(search)))).toThrow();
    }
  });
});

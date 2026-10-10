import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseListing,
  parseVersion,
  pickAv1Encoder,
  probeFfmpeg,
  toCapabilities,
  type Run,
} from "../../../src/core/ffmpeg/index.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/ffmpeg/${name}`, import.meta.url), "utf8");

// Recorded from a real ffmpeg 6.1.1; no live binary is involved.
const version = fixture("version.txt");
const encoders = fixture("encoders.txt");
const filters = fixture("filters.txt");

function fakeRun(outputs: { encoders: string; filters: string }) {
  const calls: string[][] = [];
  const run: Run = async (_file, args) => {
    calls.push(args);
    if (args.includes("-version")) return { stdout: version };
    if (args.includes("-encoders")) return { stdout: outputs.encoders };
    if (args.includes("-filters")) return { stdout: outputs.filters };
    throw new Error(`unexpected args ${args.join(" ")}`);
  };
  return { run, calls };
}

describe("parseVersion", () => {
  it("reads the version token from the first line", () => {
    expect(parseVersion(version)).toBe("6.1.1-3ubuntu5");
  });
  it("returns null for unrecognised output", () => {
    expect(parseVersion("command not found")).toBeNull();
  });
});

describe("parseListing", () => {
  it("collects encoder names and ignores legend lines", () => {
    const names = parseListing(encoders, "encoders");
    expect(names.has("libx264")).toBe(true);
    expect(names.has("libsvtav1")).toBe(true);
    expect(names.has("libvpx-vp9")).toBe(true);
    expect(names.has("=")).toBe(false);
  });
  it("collects filter names even though -filters has no rule line", () => {
    const names = parseListing(filters, "filters");
    expect(names.has("scale")).toBe(true);
    expect(names.has("=")).toBe(false);
    expect(names.has("libvmaf")).toBe(false);
  });
  it("matches filters carrying timeline/slice/command flags", () => {
    expect(parseListing(" TSC libvmaf V->V  VMAF\n .S. foo V->V x", "filters")).toEqual(
      new Set(["libvmaf", "foo"]),
    );
  });
});

describe("toCapabilities / pickAv1Encoder", () => {
  it("reports capabilities from the recorded output", () => {
    const caps = toCapabilities(
      parseListing(encoders, "encoders"),
      parseListing(filters, "filters"),
    );
    expect(caps).toEqual({
      libsvtav1: true,
      libaomAv1: true,
      libx264: true,
      libvpxVp9: true,
      libvmaf: false,
    });
    expect(pickAv1Encoder(caps)).toBe("libsvtav1");
  });
  it("detects libvmaf when the filter is present", () => {
    const caps = toCapabilities(
      new Set(),
      parseListing(fixture("filters-with-vmaf.txt"), "filters"),
    );
    expect(caps.libvmaf).toBe(true);
  });
  it("prefers libsvtav1 and falls back to libaom-av1", () => {
    const base = { libx264: true, libvpxVp9: true, libvmaf: false };
    expect(pickAv1Encoder({ ...base, libsvtav1: true, libaomAv1: true })).toBe("libsvtav1");
    expect(pickAv1Encoder({ ...base, libsvtav1: false, libaomAv1: true })).toBe("libaom-av1");
    expect(pickAv1Encoder({ ...base, libsvtav1: false, libaomAv1: false })).toBeNull();
  });
  it("sees no AV1 encoder in the no-av1 listing", () => {
    const caps = toCapabilities(
      parseListing(fixture("encoders-no-av1.txt"), "encoders"),
      new Set(),
    );
    expect(pickAv1Encoder(caps)).toBeNull();
    expect(caps.libx264).toBe(true);
  });
});

describe("probeFfmpeg", () => {
  it("caches by path + version so listings are fetched once", async () => {
    const { run, calls } = fakeRun({ encoders, filters });
    const cache = new Map();
    const first = await probeFfmpeg("/bin/ffmpeg", run, cache);
    const second = await probeFfmpeg("/bin/ffmpeg", run, cache);
    expect(second).toBe(first);
    expect(first.version).toBe("6.1.1-3ubuntu5");
    expect(calls.filter((a) => a.includes("-encoders"))).toHaveLength(1);
  });
  it("does not share a cache entry between paths", async () => {
    const { run, calls } = fakeRun({ encoders, filters });
    const cache = new Map();
    await probeFfmpeg("/a/ffmpeg", run, cache);
    await probeFfmpeg("/b/ffmpeg", run, cache);
    expect(calls.filter((a) => a.includes("-encoders"))).toHaveLength(2);
  });
});

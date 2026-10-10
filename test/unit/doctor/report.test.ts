import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  collectDoctorReport,
  formatDoctorReport,
  type DoctorDeps,
} from "../../../src/core/doctor/report.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/ffmpeg/${name}`, import.meta.url), "utf8");

function deps(overrides: Partial<DoctorDeps> & { encoders?: string; filters?: string } = {}) {
  const {
    encoders = fixture("encoders.txt"),
    filters = fixture("filters.txt"),
    ...rest
  } = overrides;
  const present = new Set(["/usr/bin/ffmpeg", "/usr/bin/ffprobe"]);
  const base: DoctorDeps = {
    nodeVersion: "v22.1.0",
    platform: "linux",
    env: { PATH: "/usr/bin" },
    osReleaseId: "ubuntu",
    isFile: (p) => present.has(p),
    async run(_file, args) {
      if (args.includes("-encoders")) return { stdout: encoders };
      if (args.includes("-filters")) return { stdout: filters };
      return { stdout: fixture("version.txt") };
    },
    async loadSharp() {
      return { version: "0.35.0", libvips: "8.18.0" };
    },
  };
  return { ...base, ...rest };
}

describe("collectDoctorReport", () => {
  it("reports sources, versions and encoders", async () => {
    const report = await collectDoctorReport(deps());
    expect(report.ffmpeg.resolved).toEqual({
      found: true,
      path: "/usr/bin/ffmpeg",
      source: "path",
    });
    expect(report.ffprobe.resolved).toMatchObject({ found: true, source: "ffmpeg-dir" });
    expect(report.encoders).toEqual({ av1: "libsvtav1", h264: true, vp9: true, vmaf: false });
    expect(report.degradations).toHaveLength(1);
    expect(report.degradations[0]).toMatch(/libvmaf/);
    expect(report.ok).toBe(true);
  });

  it("has no degradation when everything is present", async () => {
    const report = await collectDoctorReport(deps({ filters: fixture("filters-with-vmaf.txt") }));
    expect(report.degradations).toEqual([]);
    expect(formatDoctorReport(report)).toMatch(/No degradation/);
  });

  it("explains the missing-ffmpeg path with an install command", async () => {
    const report = await collectDoctorReport(deps({ isFile: () => false, platform: "darwin" }));
    expect(report.ffmpeg.resolved.found).toBe(false);
    expect(report.degradations[0]).toMatch(/needs ffmpeg/);
    expect(report.degradations[0]).toMatch(/brew install ffmpeg/);
    expect(report.ok).toBe(true);
  });

  it("warns that AV1 is skipped when no AV1 encoder exists", async () => {
    const report = await collectDoctorReport(deps({ encoders: fixture("encoders-no-av1.txt") }));
    expect(report.encoders.av1).toBeNull();
    expect(report.degradations.some((d) => /AV1 outputs will be skipped/.test(d))).toBe(true);
  });

  it("flags a missing ffprobe", async () => {
    const present = new Set(["/usr/bin/ffmpeg"]);
    const report = await collectDoctorReport(deps({ isFile: (p) => present.has(p) }));
    expect(report.degradations.some((d) => /ffprobe is not usable/.test(d))).toBe(true);
  });

  it("honours the --ffmpeg flag and reports a bad path", async () => {
    const report = await collectDoctorReport(deps(), { ffmpegFlag: "/typo/ffmpeg" });
    expect(report.ffmpeg.resolved).toEqual({
      found: false,
      source: "flag",
      attempted: "/typo/ffmpeg",
    });
    expect(report.degradations[0]).toMatch(/\/typo\/ffmpeg/);
  });

  it("survives a binary that fails to execute", async () => {
    const report = await collectDoctorReport(
      deps({
        async run() {
          throw new Error("EACCES");
        },
      }),
    );
    expect(report.ffmpeg.error).toBe("EACCES");
    expect(report.degradations[0]).toMatch(/could not be run/);
  });

  it("is not ok when sharp is unavailable or Node is too old", async () => {
    const noSharp = await collectDoctorReport(
      deps({
        async loadSharp() {
          throw new Error("no binary");
        },
      }),
    );
    expect(noSharp.sharp).toEqual({ available: false, error: "no binary" });
    expect(noSharp.ok).toBe(false);
    expect((await collectDoctorReport(deps({ nodeVersion: "v20.0.0" }))).ok).toBe(false);
  });
});

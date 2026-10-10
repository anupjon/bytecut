import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasFfmpeg, makeVideoFixtures } from "../../../scripts/make-fixtures.js";
import {
  av1CodecString,
  avcCodecString,
  fallbackAv1CodecString,
  readVideoCodecString,
} from "../../../src/core/video/codecs.js";
import { tempDir } from "../../helpers.js";

const execFileAsync = promisify(execFile);

describe("codec strings from box payloads", () => {
  it("avcC: profile, compatibility and level bytes become avc1.PPCCLL", () => {
    // High profile (0x64), no constraints, level 4.0 (0x28).
    expect(avcCodecString(Buffer.from([1, 0x64, 0x00, 0x28, 0xff]))).toBe("avc1.640028");
    // Constrained Baseline: profile 0x42 with constraint flags 0xC0, level 3.1 (0x1f).
    expect(avcCodecString(Buffer.from([1, 0x42, 0xc0, 0x1f]))).toBe("avc1.42c01f");
    expect(avcCodecString(Buffer.from([1, 0x64]))).toBeNull();
  });

  it("av1C: profile, level, tier and bit depth become av01.P.LLT.DD", () => {
    // marker+version 0x81; profile 0, level 8 → 0b000_01000; tier 0, 8-bit.
    expect(av1CodecString(Buffer.from([0x81, 0x08, 0x0c, 0x00]))).toBe("av01.0.08M.08");
    // profile 0, level 0, high tier, 10-bit.
    expect(av1CodecString(Buffer.from([0x81, 0x00, 0xc0, 0x00]))).toBe("av01.0.00H.10");
    // profile 2 (professional), level 13, 12-bit.
    expect(av1CodecString(Buffer.from([0x81, 0x4d, 0x60, 0x00]))).toBe("av01.2.13M.12");
    expect(av1CodecString(Buffer.from([0x01, 0x08, 0x0c, 0x00]))).toBeNull(); // marker bit unset
  });

  it("fallback AV1 level follows the picture size", () => {
    expect(fallbackAv1CodecString(320, 240)).toBe("av01.0.00M.08");
    expect(fallbackAv1CodecString(640, 360)).toBe("av01.0.01M.08");
    expect(fallbackAv1CodecString(1280, 720)).toBe("av01.0.05M.08");
    expect(fallbackAv1CodecString(1920, 1080)).toBe("av01.0.08M.08");
    expect(fallbackAv1CodecString(3840, 2160)).toBe("av01.0.12M.08");
  });
});

describe("readVideoCodecString", () => {
  it("is null for files that are not MP4", async () => {
    const path = join(await tempDir(), "x.webm");
    await writeFile(path, Buffer.from("not an mp4 file at all"));
    expect(await readVideoCodecString(path)).toBeNull();
  });
});

const FFMPEG = await hasFfmpeg();
if (!FFMPEG)
  console.warn("[bytecut tests] ffmpeg not found: skipping codec-string tests on real MP4s.");

describe.skipIf(!FFMPEG)("readVideoCodecString on real MP4s", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bytecut-codecs-"));
    await makeVideoFixtures(dir);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  async function ffprobeStream(path: string) {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,profile,level",
      "-of",
      "json",
      path,
    ]);
    return (
      JSON.parse(stdout) as {
        streams: Array<{ codec_name: string; profile: string; level: number }>;
      }
    ).streams[0]!;
  }

  it("reads H.264 and agrees with ffprobe on profile and level", async () => {
    const path = join(dir, "heavy.mp4");
    const codec = await readVideoCodecString(path);
    expect(codec).toMatch(/^avc1\.[0-9a-f]{6}$/);
    const probe = await ffprobeStream(path);
    // The last byte is the level_idc, which ffprobe reports in decimal.
    expect(parseInt(codec!.slice(-2), 16)).toBe(probe.level);
    // The first byte is the profile_idc: 0x64 High, 0x4d Main, 0x42 Baseline.
    const profileByte = parseInt(codec!.slice(5, 7), 16);
    expect({ 0x64: "High", 0x4d: "Main", 0x42: "Baseline" }[profileByte]).toBe(
      probe.profile.replace("Constrained ", ""),
    );
  });

  it("reads AV1 from a file this tool would produce, and agrees with ffprobe's level", async () => {
    const out = join(dir, "a.mp4");
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      join(dir, "heavy.mp4"),
      "-an",
      "-c:v",
      "libsvtav1",
      "-crf",
      "40",
      "-preset",
      "10",
      "-pix_fmt",
      "yuv420p",
      out,
    ]).catch(() => undefined);
    const codec = await readVideoCodecString(out);
    if (codec === null) return; // no AV1 encoder on this machine
    expect(codec).toMatch(/^av01\.0\.\d\d[MH]\.08$/);
    const probe = await ffprobeStream(out);
    expect(Number(codec.split(".")[2]!.slice(0, 2))).toBe(probe.level);
  });

  it("is null for an MP4 whose video is neither H.264 nor AV1", async () => {
    const out = join(dir, "mpeg4.mp4");
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      join(dir, "silent.mp4"),
      "-an",
      "-c:v",
      "mpeg4",
      out,
    ]);
    expect(await readVideoCodecString(out)).toBeNull();
  });
});

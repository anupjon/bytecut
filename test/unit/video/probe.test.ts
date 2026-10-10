import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isFastStart, parseProbe } from "../../../src/core/video/probe.js";
import { tempDir } from "../../helpers.js";

describe("parseProbe", () => {
  const json = {
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "3.000000", bit_rate: "878325" },
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 640,
        height: 360,
        r_frame_rate: "30/1",
        avg_frame_rate: "30/1",
        pix_fmt: "yuv420p",
      },
      { codec_type: "audio", codec_name: "aac" },
    ],
  };

  it("extracts what the planner and rules need", () => {
    expect(parseProbe(json)).toEqual({
      durationSec: 3,
      width: 640,
      height: 360,
      fps: 30,
      videoCodec: "h264",
      pixelFormat: "yuv420p",
      bitrate: 878325,
      hasAudio: true,
      audioCodec: "aac",
      container: "mov,mp4,m4a,3gp,3g2,mj2",
    });
  });

  it("reports silence, and prefers the average frame rate", () => {
    const silent = parseProbe({
      ...json,
      streams: [{ ...json.streams[0], r_frame_rate: "90000/1", avg_frame_rate: "30000/1001" }],
    })!;
    expect(silent.hasAudio).toBe(false);
    expect(silent.audioCodec).toBeNull();
    expect(silent.fps).toBeCloseTo(29.97, 2);
  });

  it("ignores cover art and returns null with no video stream", () => {
    const cover = {
      codec_type: "video",
      codec_name: "mjpeg",
      width: 10,
      height: 10,
      disposition: { attached_pic: 1 },
    };
    expect(
      parseProbe({ format: {}, streams: [cover, { codec_type: "audio", codec_name: "mp3" }] }),
    ).toBeNull();
    expect(parseProbe({ format: {}, streams: [] })).toBeNull();
  });

  it("tolerates missing and malformed values", () => {
    const p = parseProbe({
      format: { duration: "N/A", bit_rate: "N/A" },
      streams: [{ codec_type: "video" }],
    })!;
    expect(p.durationSec).toBe(0);
    expect(p.bitrate).toBeNull();
    expect(p.fps).toBe(0);
    expect(p.width).toBe(0);
  });
});

/** An ISO-BMFF-ish file made of boxes with the given types and sizes. */
function boxes(...parts: Array<[string, number]>): Buffer {
  return Buffer.concat(
    parts.map(([type, size]) => {
      const b = Buffer.alloc(size);
      b.writeUInt32BE(size, 0);
      b.write(type, 4, "latin1");
      return b;
    }),
  );
}

describe("isFastStart", () => {
  async function file(content: Buffer) {
    const path = join(await tempDir(), "v.mp4");
    await writeFile(path, content);
    return path;
  }

  it("is true when moov comes before mdat", async () => {
    expect(
      await isFastStart(await file(boxes(["ftyp", 24], ["moov", 100], ["free", 8], ["mdat", 500]))),
    ).toBe(true);
  });

  it("is false when mdat comes first", async () => {
    expect(
      await isFastStart(await file(boxes(["ftyp", 24], ["free", 8], ["mdat", 500], ["moov", 100]))),
    ).toBe(false);
  });

  it("is null for files that are not ISO-BMFF", async () => {
    expect(await isFastStart(await file(Buffer.from("RIFF....WEBM not an mp4 at all")))).toBeNull();
    expect(await isFastStart(await file(Buffer.alloc(0)))).toBeNull();
  });

  it("is null for a truncated or box-less file, and never loops forever", async () => {
    expect(await isFastStart(await file(boxes(["ftyp", 24])))).toBeNull();
    expect(await isFastStart(await file(boxes(["ftyp", 24], ["free", 8], ["free", 8])))).toBeNull();
    // A box claiming a size smaller than its header must not stall the walk.
    const bad = boxes(["ftyp", 24], ["free", 16]);
    bad.writeUInt32BE(2, 24);
    expect(await isFastStart(await file(bad))).toBeNull();
  });

  it("handles a 64-bit box size", async () => {
    const big = Buffer.alloc(16);
    big.writeUInt32BE(1, 0);
    big.write("free", 4, "latin1");
    big.writeBigUInt64BE(16n, 8);
    expect(
      await isFastStart(await file(Buffer.concat([boxes(["ftyp", 24]), big, boxes(["moov", 40])]))),
    ).toBe(true);
  });
});

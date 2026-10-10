import { open } from "node:fs/promises";

export interface VideoProbe {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  pixelFormat: string | null;
  /** Overall bits per second (container), or null if unknown. */
  bitrate: number | null;
  hasAudio: boolean;
  audioCodec: string | null;
  container: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}

interface FfprobeJson {
  format?: { format_name?: string; duration?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

function rate(text: string | undefined): number {
  const m = /^(\d+)\/(\d+)$/.exec(text ?? "");
  if (!m || Number(m[2]) === 0) return 0;
  return Number(m[1]) / Number(m[2]);
}

/** Parses `ffprobe -show_format -show_streams -of json`; null if there is no video stream. */
export function parseProbe(json: unknown): VideoProbe | null {
  const data = json as FfprobeJson;
  const streams = data.streams ?? [];
  // Cover art is a "video" stream too; the real one is not an attached picture.
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!video) return null;
  const audio = streams.find((s) => s.codec_type === "audio");

  const duration = Number(data.format?.duration ?? video.duration ?? 0);
  const bitrate = Number(data.format?.bit_rate);
  return {
    durationSec: Number.isFinite(duration) ? duration : 0,
    width: video.width ?? 0,
    height: video.height ?? 0,
    // avg is the real rate for variable-rate sources; r_frame_rate is the container's base.
    fps: rate(video.avg_frame_rate) || rate(video.r_frame_rate),
    videoCodec: video.codec_name ?? "unknown",
    pixelFormat: video.pix_fmt ?? null,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null,
    hasAudio: audio !== undefined,
    audioCodec: audio?.codec_name ?? null,
    container: data.format?.format_name ?? "unknown",
  };
}

/**
 * For MP4/MOV: true when `moov` precedes `mdat` (playback can start before the download
 * finishes), false when it follows, null when this isn't an ISO-BMFF file. Walks only the
 * top-level box headers, so it reads a few bytes even for a multi-gigabyte file.
 */
export async function isFastStart(path: string): Promise<boolean | null> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(16);
    let offset = 0;
    let first = true;
    for (let guard = 0; guard < 64 && offset + 8 <= size; guard++) {
      const { bytesRead } = await file.read(header, 0, 16, offset);
      if (bytesRead < 8) return null;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      if (first) {
        if (type !== "ftyp") return null;
        first = false;
      }
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (boxSize === 1) {
        if (bytesRead < 16) return null;
        boxSize = Number(header.readBigUInt64BE(8));
      } else if (boxSize === 0) {
        return null; // box extends to the end of the file without moov/mdat first
      }
      if (boxSize < 8) return null;
      offset += boxSize;
    }
    return null;
  } finally {
    await file.close();
  }
}

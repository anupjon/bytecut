import type { VideoCodec } from "../video/types.js";

export type VideoPresetName = "background-video" | "content-video" | "gif-to-video";

/** A perceptual target: the CRF is searched, on sampled clips, instead of fixed. */
export interface VideoSearch {
  metric: "ssimulacra2" | "vmaf";
  target: number;
  /** Lowest score allowed while fitting `maxBytes`. Set together with it. */
  floor?: number;
  /** Cap per output file: quality is lowered to `floor`, then the width stepped down. */
  maxBytes?: number;
}

export interface VideoPreset {
  /** A built-in name, or the name of a preset defined in the config. */
  name: string;
  /** Output order. AV1 first so the modern source is listed ahead of the H.264 fallback. */
  codecs: VideoCodec[];
  /** `strip` removes audio; `keep` re-encodes it as AAC. */
  audio: "strip" | "keep";
  audioBitrate: string;
  maxWidth: number | null;
  maxFps: number | null;
  /** Constant-rate-factor per codec. */
  crf: Record<VideoCodec, number>;
  /** When set, `crf` is only the search's starting point and the fallback without a metric. */
  search?: VideoSearch;
  /** SVT-AV1 `-preset` (6 = slower, smaller) and x264 preset name. */
  speed: Record<VideoCodec, string>;
  poster: {
    quality: number;
    effort: number;
    /** Position as a fraction of the duration. */ at: number;
  };
}

const POSTER = { quality: 55, effort: 4, at: 0.1 };

/** Muted looping backdrops: no audio, capped at 1080p and 30 fps. */
export const BACKGROUND_VIDEO_PRESET: VideoPreset = {
  name: "background-video",
  codecs: ["av1", "h264"],
  audio: "strip",
  audioBitrate: "96k",
  maxWidth: 1920,
  maxFps: 30,
  crf: { av1: 38, h264: 28 },
  speed: { av1: "6", h264: "slow" },
  poster: POSTER,
};

/** Videos people actually watch: keep audio, resolution and frame rate (§6.8). */
export const CONTENT_VIDEO_PRESET: VideoPreset = {
  name: "content-video",
  codecs: ["av1", "h264"],
  audio: "keep",
  audioBitrate: "128k",
  maxWidth: null,
  maxFps: null,
  crf: { av1: 32, h264: 23 },
  speed: { av1: "6", h264: "slow" },
  poster: POSTER,
};

/** Animated GIFs re-encoded as silent looping video. */
export const GIF_TO_VIDEO_PRESET: VideoPreset = {
  name: "gif-to-video",
  codecs: ["av1", "h264"],
  audio: "strip",
  audioBitrate: "96k",
  maxWidth: 1920,
  maxFps: null,
  crf: { av1: 36, h264: 26 },
  speed: { av1: "6", h264: "slow" },
  poster: POSTER,
};

export const VIDEO_PRESETS: Record<VideoPresetName, VideoPreset> = {
  "background-video": BACKGROUND_VIDEO_PRESET,
  "content-video": CONTENT_VIDEO_PRESET,
  "gif-to-video": GIF_TO_VIDEO_PRESET,
};

export function getVideoPreset(
  name: string,
  catalog?: { video: Record<string, VideoPreset> },
): VideoPreset | undefined {
  return (catalog?.video ?? (VIDEO_PRESETS as Record<string, VideoPreset>))[name];
}

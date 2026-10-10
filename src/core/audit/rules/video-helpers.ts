import type { VideoFacts } from "../types.js";

/** Up-to-date outputs exist, so a source-level video issue no longer reaches visitors. */
export function isVideoCovered(video: VideoFacts): boolean {
  return video.cache.kind === "hit";
}

/** Estimated saving of serving the best output instead of the source. */
export function videoSaving(video: VideoFacts): number | undefined {
  if (!video.estimate) return undefined;
  return Math.max(0, video.bytes - video.estimate.best.bytes);
}

/** Codecs every current browser can play from an MP4. */
export const UNIVERSAL_CODECS = new Set(["h264", "avc1"]);
/** Codecs that are efficient and widely supported on the web today. */
export const MODERN_CODECS = new Set(["av1", "vp9"]);

/** Human name for a codec as ffprobe reports it. */
export function codecLabel(codec: string): string {
  switch (codec) {
    case "h264":
      return "H.264";
    case "hevc":
      return "HEVC";
    case "vp9":
      return "VP9";
    case "av1":
      return "AV1";
    default:
      return codec.toUpperCase();
  }
}

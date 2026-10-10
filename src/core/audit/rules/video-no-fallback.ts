import type { AuditRule, Finding } from "../types.js";
import { UNIVERSAL_CODECS, codecLabel, isVideoCovered } from "./video-helpers.js";

const ID = "video/no-fallback";

/** A source only some browsers can play, with no H.264 MP4 to fall back to. */
export const videoNoFallback: AuditRule = {
  id: ID,
  category: "video",
  defaultSeverity: "warn",
  fix: "optimize",

  async check(ctx) {
    const findings: Finding[] = [];
    for (const video of ctx.videos) {
      if (video.isGif || UNIVERSAL_CODECS.has(video.probe.videoCodec)) continue;
      if (isVideoCovered(video)) continue;
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: video.source,
        message: `${codecLabel(video.probe.videoCodec)} is not playable everywhere and there is no H.264 MP4 fallback`,
        current: video.bytes,
      });
    }
    return findings;
  },
};

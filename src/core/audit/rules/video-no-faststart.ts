import type { AuditRule, Finding } from "../types.js";
import { isVideoCovered } from "./video-helpers.js";

const ID = "video/no-faststart";

export const videoNoFaststart: AuditRule = {
  id: ID,
  category: "video",
  defaultSeverity: "warn",
  fix: "optimize",

  async check(ctx) {
    const findings: Finding[] = [];
    for (const video of ctx.videos) {
      if (video.faststart !== false || isVideoCovered(video)) continue;
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: video.source,
        message:
          "moov atom is after the media data, so playback waits for the whole file; outputs are faststart",
        current: video.bytes,
      });
    }
    return findings;
  },
};

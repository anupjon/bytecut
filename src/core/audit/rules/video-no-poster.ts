import type { AuditRule, Finding } from "../types.js";
import { isVideoCovered } from "./video-helpers.js";

const ID = "video/no-poster";

export const videoNoPoster: AuditRule = {
  id: ID,
  category: "video",
  defaultSeverity: "info",
  fix: "optimize",

  async check(ctx) {
    const findings: Finding[] = [];
    for (const video of ctx.videos) {
      if (video.hasPoster || isVideoCovered(video)) continue;
      findings.push({
        ruleId: ID,
        severity: "info",
        source: video.source,
        message: "no poster image, so nothing shows before the first frame loads; one is generated",
        current: video.bytes,
      });
    }
    return findings;
  },
};

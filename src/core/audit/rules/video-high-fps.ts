import type { AuditRule, Finding } from "../types.js";
import { ruleOptions } from "./helpers.js";
import { isVideoCovered } from "./video-helpers.js";

const ID = "video/high-fps";

export const videoHighFps: AuditRule = {
  id: ID,
  category: "video",
  defaultSeverity: "warn",
  fix: "optimize",

  async check(ctx) {
    const { maxFps } = ruleOptions(ctx, ID, { maxFps: 30 });
    const findings: Finding[] = [];
    for (const video of ctx.videos) {
      if (video.probe.fps <= maxFps + 0.01 || isVideoCovered(video)) continue;
      const capped = video.classification.preset === "background-video";
      findings.push({
        ruleId: ID,
        severity: capped ? "warn" : "info",
        source: video.source,
        message: capped
          ? `${Math.round(video.probe.fps)} fps is more than a backdrop needs; outputs are capped at ${maxFps}`
          : `${Math.round(video.probe.fps)} fps; kept as-is because it looks like content`,
        current: video.bytes,
      });
    }
    return findings;
  },
};

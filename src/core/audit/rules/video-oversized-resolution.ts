import type { AuditRule, Finding } from "../types.js";
import { ruleOptions } from "./helpers.js";
import { isVideoCovered, videoSaving } from "./video-helpers.js";

const ID = "video/oversized-resolution";

export const videoOversizedResolution: AuditRule = {
  id: ID,
  category: "video",
  defaultSeverity: "warn",
  fix: "optimize",

  async check(ctx) {
    const { maxWidth } = ruleOptions(ctx, ID, { maxWidth: 1920 });
    const findings: Finding[] = [];
    for (const video of ctx.videos) {
      const { width, height } = video.probe;
      if (Math.max(width, height) <= maxWidth || isVideoCovered(video)) continue;
      // Only the background preset caps resolution; content keeps it (§6.8), so say so.
      const capped = video.classification.preset !== "content-video";
      const saving = videoSaving(video);
      findings.push({
        ruleId: ID,
        severity: capped ? "warn" : "info",
        source: video.source,
        message: capped
          ? `${width}x${height} exceeds ${maxWidth}px; outputs are capped`
          : `${width}x${height} exceeds ${maxWidth}px; kept as-is because it looks like content (use the background-video preset to cap it)`,
        current: video.bytes,
        ...(video.estimate ? { estimated: video.estimate.best.bytes } : {}),
        ...(saving !== undefined ? { savingsBytes: saving } : {}),
      });
    }
    return findings;
  },
};

import type { AuditRule, Finding } from "../types.js";
import { MODERN_CODECS, codecLabel, isVideoCovered, videoSaving } from "./video-helpers.js";
import { ruleOptions } from "./helpers.js";

const ID = "video/no-modern-codec";

export const videoNoModernCodec: AuditRule = {
  id: ID,
  category: "video",
  defaultSeverity: "warn",
  fix: "optimize",

  async check(ctx) {
    const { minSavingsBytes } = ruleOptions(ctx, ID, { minSavingsBytes: 10 * 1024 });
    const findings: Finding[] = [];
    for (const video of ctx.videos) {
      if (video.isGif) continue; // covered by gif/animated
      if (MODERN_CODECS.has(video.probe.videoCodec) || isVideoCovered(video)) continue;
      const saving = videoSaving(video);
      // An estimate that doesn't beat the source means re-encoding wouldn't help (§6.7).
      if (saving !== undefined && saving < minSavingsBytes) continue;
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: video.source,
        message: `${codecLabel(video.probe.videoCodec)} source has no AV1 output`,
        current: video.bytes,
        ...(video.estimate ? { estimated: video.estimate.best.bytes } : {}),
        ...(saving !== undefined ? { savingsBytes: saving } : {}),
      });
    }
    return findings;
  },
};

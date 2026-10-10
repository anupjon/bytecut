import { extname } from "node:path";
import type { AuditRule, Finding } from "../types.js";
import { isVideoCovered, videoSaving } from "./video-helpers.js";

const ID = "gif/animated";

/**
 * An animated GIF is a video in disguise, and usually several times larger than one. With
 * ffmpeg it carries a real estimate; without, it is still listed with what to install, never
 * silently skipped (§4).
 */
export const gifAnimated: AuditRule = {
  id: ID,
  category: "gif",
  defaultSeverity: "warn",
  fix: "optimize",

  async check(ctx) {
    const findings: Finding[] = [];
    for (const video of ctx.videos) {
      if (!video.isGif || isVideoCovered(video)) continue;
      const saving = videoSaving(video);
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: video.source,
        message: "animated GIF; a looping muted video is typically far smaller",
        current: video.bytes,
        ...(video.estimate ? { estimated: video.estimate.best.bytes } : {}),
        ...(saving !== undefined ? { savingsBytes: saving } : {}),
      });
    }
    for (const gif of ctx.unprobed) {
      if (extname(gif.source).toLowerCase() !== ".gif") continue;
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: gif.source,
        message: `animated GIF; a looping muted video is typically far smaller. Needs ffmpeg: ${ctx.ffmpeg.installHint}`,
        current: gif.bytes,
      });
    }
    return findings;
  },
};

import type { AuditRule, Finding } from "../types.js";
import { ruleOptions } from "./helpers.js";
import { isVideoCovered, videoSaving } from "./video-helpers.js";

const ID = "video/high-bitrate";

/**
 * Bits per pixel per frame is resolution- and frame-rate-independent, unlike raw bitrate,
 * so one threshold works for a 360p clip and a 4K one. Web H.264 is typically 0.05–0.1.
 */
export const videoHighBitrate: AuditRule = {
  id: ID,
  category: "video",
  defaultSeverity: "warn",
  fix: "optimize",

  async check(ctx) {
    const { maxBitsPerPixel, minBytes } = ruleOptions(ctx, ID, {
      maxBitsPerPixel: 0.2,
      minBytes: 200 * 1024,
    });
    const findings: Finding[] = [];
    for (const video of ctx.videos) {
      const { bitrate, width, height, fps } = video.probe;
      if (bitrate === null || width * height * fps === 0) continue;
      if (video.bytes < minBytes || isVideoCovered(video)) continue;
      const bpp = bitrate / (width * height * fps);
      if (bpp <= maxBitsPerPixel) continue;
      const saving = videoSaving(video);
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: video.source,
        message: `${bpp.toFixed(2)} bits per pixel per frame (over ${maxBitsPerPixel})`,
        current: video.bytes,
        ...(video.estimate ? { estimated: video.estimate.best.bytes } : {}),
        ...(saving !== undefined ? { savingsBytes: saving } : {}),
      });
    }
    return findings;
  },
};

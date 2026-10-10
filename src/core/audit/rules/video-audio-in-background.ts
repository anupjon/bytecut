import type { AuditRule, Finding } from "../types.js";
import { isVideoCovered } from "./video-helpers.js";

const ID = "video/audio-in-background";

/**
 * The classifier only treats a clip with sound as a backdrop on a strong signal (a backdrop
 * name on a short clip), because removing audio is the one change that can't be undone.
 */
export const videoAudioInBackground: AuditRule = {
  id: ID,
  category: "video",
  defaultSeverity: "warn",
  fix: "optimize",

  async check(ctx) {
    const findings: Finding[] = [];
    for (const video of ctx.videos) {
      if (!video.probe.hasAudio || video.classification.preset !== "background-video") continue;
      if (isVideoCovered(video)) continue;
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: video.source,
        message: "looks like a background video but carries an audio track; outputs drop it",
        current: video.bytes,
      });
    }
    return findings;
  },
};

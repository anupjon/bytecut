import type { AuditRule, Finding } from "../types.js";

const ID = "gif/animated";

/**
 * Reported with no savings number: a trustworthy estimate needs a trial encode with ffmpeg,
 * which arrives in M5. Per §4 it is never silently skipped, and says what to install.
 */
export const gifAnimated: AuditRule = {
  id: ID,
  category: "gif",
  defaultSeverity: "warn",
  fix: null,

  async check(ctx) {
    const findings: Finding[] = [];
    for (const gif of ctx.skipped) {
      if (!gif.animatedGif) continue;
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: gif.source,
        message: ctx.ffmpeg.found
          ? "animated GIF; a looping video is typically far smaller (conversion arrives in M5)"
          : `animated GIF; a looping video is typically far smaller. Needs ffmpeg: ${ctx.ffmpeg.installHint}`,
        current: gif.bytes,
      });
    }
    return findings;
  },
};

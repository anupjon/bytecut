import type { AuditRule, Finding } from "../types.js";
import { isCovered, savingOf } from "./helpers.js";

const ID = "gif/static";

export const gifStatic: AuditRule = {
  id: ID,
  category: "gif",
  defaultSeverity: "warn",
  fix: "optimize",

  async check(ctx) {
    const findings: Finding[] = [];
    for (const image of ctx.images) {
      if (image.analysis.format !== "gif" || isCovered(image)) continue;
      const saving = savingOf(image);
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: image.source,
        message: "GIF with a single frame; use a modern still image format",
        current: image.bytes,
        ...(image.estimate ? { estimated: image.estimate.best.bytes } : {}),
        ...(saving !== undefined ? { savingsBytes: saving } : {}),
      });
    }
    return findings;
  },
};

import type { AuditRule, Finding } from "../types.js";
import { isCovered, ruleOptions, savingOf } from "./helpers.js";

const ID = "image/heavy";

export const heavy: AuditRule = {
  id: ID,
  category: "image",
  defaultSeverity: "warn",
  fix: null,

  async check(ctx) {
    const { maxBytes } = ruleOptions(ctx, ID, { maxBytes: 500 * 1000 });
    const findings: Finding[] = [];
    for (const image of ctx.images) {
      if (image.bytes <= maxBytes || isCovered(image)) continue;
      const saving = savingOf(image);
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: image.source,
        message: `source exceeds the ${maxBytes}-byte limit`,
        current: image.bytes,
        ...(image.estimate ? { estimated: image.estimate.best.bytes } : {}),
        ...(saving !== undefined ? { savingsBytes: saving } : {}),
      });
    }
    return findings;
  },
};

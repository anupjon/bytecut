import type { AuditRule, Finding } from "../types.js";
import { isCovered, ruleOptions, savingOf } from "./helpers.js";

const ID = "image/no-modern-format";

export const noModernFormat: AuditRule = {
  id: ID,
  category: "image",
  defaultSeverity: "warn",
  fix: "optimize",

  async check(ctx) {
    const { minSavingsBytes } = ruleOptions(ctx, ID, { minSavingsBytes: 1024 });
    const findings: Finding[] = [];
    for (const image of ctx.images) {
      const { format } = image.analysis;
      if (format !== "jpeg" && format !== "png" && format !== "gif") continue;
      if (isCovered(image)) continue;
      const saving = savingOf(image);
      // An estimate that doesn't beat the source means optimizing wouldn't help (§6.7).
      if (saving === undefined || saving < minSavingsBytes) continue;
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: image.source,
        message: `${format.toUpperCase()} source has no up-to-date optimized outputs`,
        current: image.bytes,
        estimated: image.estimate!.best.bytes,
        savingsBytes: saving,
      });
    }
    return findings;
  },
};

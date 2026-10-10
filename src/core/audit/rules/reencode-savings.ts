import type { AuditRule, Finding } from "../types.js";
import { isCovered, ruleOptions, savingOf } from "./helpers.js";

const ID = "image/reencode-savings";

/** Sources already in a modern format that a fresh encode at the preset still shrinks a lot. */
export const reencodeSavings: AuditRule = {
  id: ID,
  category: "image",
  defaultSeverity: "info",
  fix: null,

  async check(ctx) {
    const { minPercent, minBytes } = ruleOptions(ctx, ID, { minPercent: 25, minBytes: 10 * 1024 });
    const findings: Finding[] = [];
    for (const image of ctx.images) {
      const { format } = image.analysis;
      if ((format !== "webp" && format !== "avif") || isCovered(image)) continue;
      const saving = savingOf(image);
      if (saving === undefined || saving < minBytes) continue;
      if ((saving / image.bytes) * 100 < minPercent) continue;
      findings.push({
        ruleId: ID,
        severity: "info",
        source: image.source,
        message: `already ${format.toUpperCase()}, but re-encoding at the ${image.item.preset} preset saves a lot`,
        current: image.bytes,
        estimated: image.estimate!.best.bytes,
        savingsBytes: saving,
      });
    }
    return findings;
  },
};

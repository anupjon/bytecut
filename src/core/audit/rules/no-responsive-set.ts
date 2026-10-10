import type { AuditRule, Finding } from "../types.js";
import { isCovered, ruleOptions } from "./helpers.js";

const ID = "image/no-responsive-set";

/**
 * A wide image with no generated set of widths means every visitor downloads the full-size
 * file. Delivery, not bytes, so it carries no savings number.
 */
export const noResponsiveSet: AuditRule = {
  id: ID,
  category: "image",
  defaultSeverity: "info",
  fix: null,

  async check(ctx) {
    const { minWidth } = ruleOptions(ctx, ID, { minWidth: 1000 });
    const findings: Finding[] = [];
    for (const image of ctx.images) {
      if (image.analysis.width < minWidth || isCovered(image)) continue;
      const widths = new Set(image.item.outputs.map((o) => o.width));
      if (widths.size < 2) continue; // the planner couldn't make a set either
      findings.push({
        ruleId: ID,
        severity: "info",
        source: image.source,
        message: `${image.analysis.width}px wide with no responsive set (${widths.size} widths would be generated)`,
        current: image.bytes,
      });
    }
    return findings;
  },
};

import type { AuditRule, Finding } from "../types.js";
import { ruleOptions } from "./helpers.js";

const ID = "svg/unminified";

export const svgUnminified: AuditRule = {
  id: ID,
  category: "svg",
  defaultSeverity: "warn",
  fix: null,

  async check(ctx) {
    const { minPercent, minBytes } = ruleOptions(ctx, ID, { minPercent: 10, minBytes: 256 });
    const findings: Finding[] = [];
    for (const svg of ctx.svgs) {
      if (svg.minifiedBytes === null) continue;
      const saving = svg.bytes - svg.minifiedBytes;
      if (saving < minBytes || (saving / svg.bytes) * 100 < minPercent) continue;
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: svg.source,
        message: "contains comments, metadata or whitespace that svgo removes",
        current: svg.bytes,
        estimated: svg.minifiedBytes,
        savingsBytes: saving,
      });
    }
    return findings;
  },
};

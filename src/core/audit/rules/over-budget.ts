import type { AuditContext, AuditRule, Finding, ImageFacts } from "../types.js";

const ID = "project/over-budget";

/**
 * Bytes a visitor would actually be served for this image: the best written output once
 * optimized, otherwise the source itself.
 */
export function servedBytes(image: ImageFacts, ctx: AuditContext): number {
  const entry = ctx.manifest?.sources[image.source];
  if (image.cache.kind === "hit" && entry) {
    const written = entry.outputs.filter((o) => o.status === "written");
    if (written.length > 0) {
      const widest = Math.max(...written.map((o) => o.width));
      return Math.min(...written.filter((o) => o.width === widest).map((o) => o.bytes));
    }
  }
  return image.bytes;
}

/** Inert until budgets are supplied; config arrives in M7 and `check` in M8. */
export const overBudget: AuditRule = {
  id: ID,
  category: "project",
  defaultSeverity: "error",
  fix: null,

  async check(ctx) {
    const { maxFileBytes, maxTotalBytes } = ctx.budgets;
    const findings: Finding[] = [];
    let total = 0;
    for (const image of ctx.images) {
      const bytes = servedBytes(image, ctx);
      total += bytes;
      if (maxFileBytes !== undefined && bytes > maxFileBytes) {
        findings.push({
          ruleId: ID,
          severity: "error",
          source: image.source,
          message: `served size is over the per-file budget of ${maxFileBytes} bytes`,
          current: bytes,
        });
      }
    }
    if (maxTotalBytes !== undefined && total > maxTotalBytes) {
      findings.push({
        ruleId: ID,
        severity: "error",
        message: `total served image size is over the budget of ${maxTotalBytes} bytes`,
        current: total,
      });
    }
    return findings;
  },
};

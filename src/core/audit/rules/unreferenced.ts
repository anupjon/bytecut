import type { AuditRule, Finding } from "../types.js";

const ID = "project/unreferenced";

/**
 * Name-based and static, so dynamic references are invisible to it; that is why it is an
 * `info` and why it says "no reference found" rather than "unused".
 */
export const unreferenced: AuditRule = {
  id: ID,
  category: "project",
  defaultSeverity: "info",
  fix: null,

  async check(ctx) {
    if (!ctx.references) return [];
    const refs = ctx.references;
    const findings: Finding[] = [];
    const files = [
      ...ctx.images.map((i) => ({ source: i.source, bytes: i.bytes })),
      ...ctx.skipped.map((s) => ({ source: s.source, bytes: s.bytes })),
      ...ctx.svgs.map((s) => ({ source: s.source, bytes: s.bytes })),
    ];
    for (const file of files) {
      const name = file.source.split("/").pop()!.toLowerCase();
      if (refs.has(name)) continue;
      findings.push({
        ruleId: ID,
        severity: "info",
        source: file.source,
        message: "no reference to this file name found in project source files",
        current: file.bytes,
        savingsBytes: file.bytes,
      });
    }
    return findings;
  },
};

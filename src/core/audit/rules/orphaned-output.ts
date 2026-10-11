import type { AuditRule, Finding, ProjectContext } from "../types.js";

const ID = "project/orphaned-output";

/**
 * Reporting only: nothing is deleted. Everything reported is listed in the manifest, which
 * is the precondition for ever deleting it (§6.3).
 */
export const orphanedOutput: AuditRule<ProjectContext> = {
  id: ID,
  category: "project",
  defaultSeverity: "info",
  fix: null,

  async check(ctx) {
    const findings: Finding[] = [];
    if (!ctx.manifest) return findings;
    const planned = new Map(ctx.plan.items.map((i) => [i.source, i]));

    for (const [source, entry] of Object.entries(ctx.manifest.sources)) {
      if (!(await ctx.sourceExists(source))) {
        for (const out of entry.outputs) {
          findings.push({
            ruleId: ID,
            severity: "info",
            source,
            path: out.path,
            message: "source no longer exists",
          });
        }
        continue;
      }

      // Only judge outputs of sources in this run's scope; an unscanned source's plan is unknown.
      const item = planned.get(source);
      if (!item || item.skip) continue;
      const wanted = new Set(item.outputs.map((o) => o.path));
      for (const out of entry.outputs) {
        // A width stepped down to fit a size cap is still what the plan asks for.
        if (!wanted.has(out.path) && !wanted.has(out.search?.plannedPath ?? "")) {
          findings.push({
            ruleId: ID,
            severity: "info",
            source,
            path: out.path,
            message: "no longer produced by the current preset",
          });
        }
      }
    }

    for (const [source, entry] of Object.entries(ctx.manifest.videos)) {
      if (!(await ctx.sourceExists(source))) {
        for (const out of entry.outputs) {
          findings.push({
            ruleId: ID,
            severity: "info",
            source,
            path: out.path,
            message: "source no longer exists",
          });
        }
        continue;
      }
      const item = (ctx.plan.videos ?? []).find((v) => v.source === source);
      if (!item || item.skip) continue;
      const wanted = new Set(item.outputs.map((o) => o.path));
      for (const out of entry.outputs) {
        if (!wanted.has(out.path) && !wanted.has(out.search?.plannedPath ?? "")) {
          findings.push({
            ruleId: ID,
            severity: "info",
            source,
            path: out.path,
            message: "no longer produced by the current preset",
          });
        }
      }
    }
    return findings;
  },
};

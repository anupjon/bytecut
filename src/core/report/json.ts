import type { AuditReport } from "../commands/audit.js";
import type { CheckVerdict } from "../commands/check.js";

/** Machine-readable `check` report: a stable shape for scripts and PR bots. */
export function renderJsonReport(report: AuditReport, verdict: CheckVerdict): string {
  return `${JSON.stringify(
    {
      version: 1,
      ok: verdict.ok,
      failOn: verdict.failOn,
      counts: verdict.counts,
      changed: verdict.scope,
      findings: verdict.findings,
      failing: verdict.failing.length,
      scanned: report.counts,
      totals: report.totals,
      unprobed: report.unprobed,
      notes: report.notes,
    },
    null,
    2,
  )}\n`;
}

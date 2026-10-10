import type { Finding } from "../audit/types.js";
import type { AuditReport } from "./audit.js";
import type { ChangedFiles } from "../git/changed.js";

export type FailOn = "error" | "warn";

export interface CheckVerdict {
  ok: boolean;
  failOn: FailOn;
  /** Findings that count after the `--changed` filter. */
  findings: Finding[];
  /** The findings that make the check fail. */
  failing: Finding[];
  counts: { error: number; warn: number; info: number };
  /** Present with `--changed`. */
  scope: { base: string; changedFiles: number; everything: boolean; dropped: number } | null;
}

/**
 * The CI verdict. With `changed`, the audit still covered the whole project (so project-wide
 * rules such as the total budget are right) and only findings about changed files, plus
 * project-level findings that name no file, are kept.
 */
export function evaluate(
  report: AuditReport,
  options: { failOn?: FailOn; changed?: ChangedFiles | null } = {},
): CheckVerdict {
  const failOn = options.failOn ?? "error";
  const changed = options.changed ?? null;

  const inScope = (f: Finding) =>
    !changed || changed.all || f.source === undefined || changed.files.has(f.source);
  const findings = report.findings.filter(inScope);

  const failing = findings.filter(
    (f) => f.severity === "error" || (failOn === "warn" && f.severity === "warn"),
  );
  const count = (s: Finding["severity"]) => findings.filter((f) => f.severity === s).length;
  return {
    ok: failing.length === 0,
    failOn,
    findings,
    failing,
    counts: { error: count("error"), warn: count("warn"), info: count("info") },
    scope: changed
      ? {
          base: changed.base,
          changedFiles: changed.files.size,
          everything: changed.all,
          dropped: report.findings.length - findings.length,
        }
      : null,
  };
}

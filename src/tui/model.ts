import { ALL_RULES } from "../core/audit/rules/index.js";
import type { Finding } from "../core/audit/types.js";
import type { AuditReport, FileSummary } from "../core/commands/audit.js";

const FIX_BY_RULE = new Map(ALL_RULES.map((r) => [r.id, r.fix]));

export interface Row {
  source: string;
  /** Decides which presets `p` offers: videos and animated GIFs have their own. */
  kind: "image" | "video";
  bytes: number;
  width: number;
  height: number;
  /** Preset the classifier chose; the user's override is held in the TUI state. */
  preset: string;
  reason: string;
  estimatedBytes: number | null;
  savingsBytes: number | null;
  plannedOutputs: number;
  /** Findings that running optimize on this file resolves. */
  findings: Finding[];
  /** Highest severity among `findings`. */
  severity: "error" | "warn" | "info";
}

export interface Model {
  /** Optimizable images with at least one fixable finding. */
  rows: Row[];
  /** Findings optimize cannot fix (SVG, duplicates, animated GIFs, unreferenced, ...). */
  reportOnly: Finding[];
  /** Files whose outputs are already up to date. */
  covered: number;
  /** Files that cannot be processed, with why. */
  skipped: Array<{ source: string; reason: string }>;
  notes: string[];
}

const RANK = { error: 0, warn: 1, info: 2 } as const;

/** Splits an audit report into what the TUI can act on and what it can only show. */
export function buildModel(report: AuditReport): Model {
  const files = new Map<string, FileSummary>(report.files.map((f) => [f.source, f]));
  const fixable = new Map<string, Finding[]>();
  const reportOnly: Finding[] = [];

  for (const finding of report.findings) {
    const file = finding.source ? files.get(finding.source) : undefined;
    const canFix = FIX_BY_RULE.get(finding.ruleId) === "optimize" && file && !file.skipped;
    if (canFix && finding.source) {
      fixable.set(finding.source, [...(fixable.get(finding.source) ?? []), finding]);
    } else {
      reportOnly.push(finding);
    }
  }

  const rows: Row[] = [];
  for (const [source, findings] of fixable) {
    const file = files.get(source)!;
    if (file.covered) continue;
    const severity = findings.reduce<Row["severity"]>(
      (best, f) => (RANK[f.severity] < RANK[best] ? f.severity : best),
      "info",
    );
    rows.push({
      source,
      kind: file.kind ?? "image",
      bytes: file.bytes,
      width: file.width,
      height: file.height,
      preset: file.preset,
      reason: file.reason,
      estimatedBytes: file.estimatedBytes,
      savingsBytes: file.savingsBytes,
      plannedOutputs: file.plannedOutputs,
      findings,
      severity,
    });
  }
  // Biggest saving first: that is what a person scanning the list cares about.
  rows.sort(
    (a, b) => (b.savingsBytes ?? 0) - (a.savingsBytes ?? 0) || (a.source < b.source ? -1 : 1),
  );

  return {
    rows,
    reportOnly,
    covered: report.files.filter((f) => f.covered).length,
    skipped: report.files
      .filter((f) => f.skipped)
      .map((f) => ({ source: f.source, reason: f.skipped! })),
    notes: report.notes,
  };
}

/** §4: `warn` and above are selected by default, `info` is not. */
export function defaultSelection(rows: Row[]): Set<string> {
  return new Set(rows.filter((r) => r.severity !== "info").map((r) => r.source));
}

export function selectionTotals(rows: Row[], selected: Set<string>) {
  let bytes = 0;
  let savings = 0;
  let count = 0;
  for (const row of rows) {
    if (!selected.has(row.source)) continue;
    count++;
    bytes += row.bytes;
    savings += row.savingsBytes ?? 0;
  }
  return { count, bytes, savings };
}

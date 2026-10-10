import type { Finding } from "../audit/types.js";
import type { AuditReport } from "../commands/audit.js";
import type { CheckVerdict } from "../commands/check.js";
import { formatBytes, percentChange, plural } from "../units.js";

/** GitHub rejects comments over 65,536 characters; stay well under it. */
export const MARKDOWN_LIMIT = 60_000;
const ROWS_PER_RULE = 20;

const SEVERITY_ORDER: Record<string, number> = { error: 0, warn: 1, info: 2 };

/** Table cells must not break the table or turn into markup. */
function cell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[`*_<>[\]]/g, (c) => `\\${c}`)
    .replace(/\r?\n/g, " ");
}

function size(f: Finding): string {
  if (f.current !== undefined && f.estimated !== undefined) {
    return `${formatBytes(f.current)} → ~${formatBytes(f.estimated)} (${percentChange(f.current, f.estimated)})`;
  }
  return f.current !== undefined ? formatBytes(f.current) : "";
}

/** A PR-comment report: verdict first, then findings per rule, truncated to fit. */
export function renderMarkdownReport(report: AuditReport, verdict: CheckVerdict): string {
  const out: string[] = [];
  const { counts, scope } = verdict;
  out.push(`## bytecut check: ${verdict.ok ? "passed" : "failed"}`, "");

  const summary = [
    `${plural(counts.error, "error")}, ${plural(counts.warn, "warning")}, ${counts.info} info`,
  ];
  const c = report.counts;
  summary.push(
    `scanned ${plural(c.images + c.skipped, "image")}, ${plural(c.svgs, "SVG")}, ${plural(c.videos, "video")} (${formatBytes(report.totals.sourceBytes)})`,
  );
  if (scope) {
    summary.push(
      scope.everything
        ? `a bytecut config changed since \`${cell(scope.base)}\`, so every file is in scope`
        : `${plural(scope.changedFiles, "file")} changed since \`${cell(scope.base)}\``,
    );
  }
  out.push(summary.join(" · "), "");
  if (!verdict.ok) {
    out.push(
      `Failing on ${verdict.failOn === "warn" ? "warnings and errors" : "errors"}: ${plural(verdict.failing.length, "finding")}.`,
      "",
    );
  }

  const groups = new Map<string, Finding[]>();
  for (const f of verdict.findings) groups.set(f.ruleId, [...(groups.get(f.ruleId) ?? []), f]);
  const ordered = [...groups.entries()].sort(([ia, a], [ib, b]) => {
    const d = (SEVERITY_ORDER[a[0]!.severity] ?? 9) - (SEVERITY_ORDER[b[0]!.severity] ?? 9);
    return d || (ia < ib ? -1 : 1);
  });

  const tail: string[] = [];
  if (report.unprobed.length > 0) {
    tail.push(
      `> ${plural(report.unprobed.length, "video")} not analysed because ffmpeg was not found.`,
    );
  }
  for (const note of report.notes) tail.push(`> ${cell(note)}`);

  let omitted = 0;
  for (const [ruleId, findings] of ordered) {
    const section: string[] = [
      `### \`${ruleId}\` · ${findings[0]!.severity} · ${plural(findings.length, "file")}`,
      "",
      "| File | Size | Detail |",
      "| --- | --- | --- |",
    ];
    for (const f of findings.slice(0, ROWS_PER_RULE)) {
      const where = f.path ? `${f.source ?? ""} → ${f.path}` : (f.source ?? "(project)");
      section.push(`| ${cell(where)} | ${cell(size(f))} | ${cell(f.message)} |`);
    }
    if (findings.length > ROWS_PER_RULE) {
      section.push("", `… and ${findings.length - ROWS_PER_RULE} more.`);
    }
    section.push("");
    const text = section.join("\n");
    // Keep room for the closing note about what was left out.
    if (out.join("\n").length + text.length + tail.join("\n").length + 200 > MARKDOWN_LIMIT) {
      omitted += findings.length;
      continue;
    }
    out.push(text);
  }
  if (omitted > 0) {
    out.push(
      `_${plural(omitted, "more finding")} not shown: this comment hit its size limit. Run \`bytecut check\` locally for the full list._`,
      "",
    );
  }
  out.push(...tail);
  return `${out.join("\n").trimEnd()}\n`;
}

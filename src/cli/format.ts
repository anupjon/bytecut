import type { Finding } from "../core/audit/types.js";
import type { AuditReport } from "../core/commands/audit.js";
import type { CacheState } from "../core/manifest/cache.js";
import type { ItemResult, OutputResult, RunResult } from "../core/execute/run.js";
import type { Plan } from "../core/plan/types.js";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

function percentChange(before: number, after: number): string {
  if (before === 0) return "n/a";
  const change = Math.round(((after - before) / before) * 100);
  return `${change > 0 ? "+" : ""}${change}%`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function formatPlan(plan: Plan, cache?: Map<string, CacheState>): string {
  const lines: string[] = [];
  const active = plan.items.filter((i) => !i.skip);
  const unchanged = active.filter((i) => cache?.get(i.source)?.kind === "hit").length;
  const note = unchanged > 0 ? ` (${unchanged} unchanged, will be skipped)` : "";
  lines.push(`Plan: ${plural(active.length, "image")} → ${plan.outDir}${note}`);
  for (const item of plan.items) {
    lines.push("");
    const dims = `${formatBytes(item.sourceBytes)}, ${item.sourceWidth}x${item.sourceHeight}`;
    const preset = item.skip
      ? ""
      : `, ${item.preset}${item.classification ? `: ${item.classification.reason}` : ""}`;
    lines.push(`${item.source} (${dims}${preset})`);
    if (item.skip) {
      lines.push(`  skipped: ${item.skip.reason}`);
      continue;
    }
    if (cache?.get(item.source)?.kind === "hit") {
      lines.push("  unchanged: outputs are up to date");
      continue;
    }
    for (const out of item.outputs) {
      const mode = out.lossless ? "lossless" : `q${out.quality}`;
      lines.push(`  ${out.path}  (${out.format}, ${out.width}w, ${mode})`);
    }
  }
  return lines.join("\n");
}

function itemLabel(item: ItemResult): string {
  switch (item.status) {
    case "skipped":
      return `skipped: ${item.reason}`;
    case "cached":
      return "unchanged";
    case "failed":
      return `failed${item.reason ? `: ${item.reason}` : ""}`;
    case "cancelled":
      return "cancelled";
    default:
      return "";
  }
}

function outputLine(out: OutputResult, sourceBytes: number): string {
  const head = `  ${out.format.padEnd(4)} ${String(out.width).padStart(5)}w`;
  const size = formatBytes(out.bytes);
  switch (out.status) {
    case "written":
      return `${head}  ${size.padStart(9)}  ${percentChange(sourceBytes, out.bytes)}`;
    case "unchanged":
      return `${head}  ${size.padStart(9)}  ${percentChange(sourceBytes, out.bytes)}  (already on disk)`;
    case "already-optimal":
      return `${head}  already optimal (${size} ≥ source), not written`;
    case "protected":
      return `${head}  left alone: existing file not owned by bytecut (use --force)`;
    case "failed":
      return `${head}  failed: ${out.error}`;
    case "cancelled":
      return `${head}  cancelled`;
  }
}

/**
 * Bytes one image costs a visitor once optimized: its widest output in the smaller format,
 * never more than the source itself (§6.7). This is the same measure `audit` estimates, so
 * the two commands' headline numbers agree.
 */
function servedBytes(item: ItemResult): number | null {
  const usable = item.outputs.filter((o) => o.status === "written" || o.status === "unchanged");
  if (usable.length === 0) return null;
  const widest = Math.max(...usable.map((o) => o.width));
  const best = Math.min(...usable.filter((o) => o.width === widest).map((o) => o.bytes));
  return Math.min(best, item.sourceBytes);
}

export function formatSummary(result: RunResult): string {
  const lines: string[] = [];
  let written = 0;
  let writtenBytes = 0;
  let unchangedItems = 0;
  let servedSource = 0;
  let served = 0;

  for (const item of result.items) {
    if (item.status === "cached") unchangedItems++;
    lines.push(`${item.source}  ${formatBytes(item.sourceBytes)}  ${itemLabel(item)}`.trimEnd());
    // Cached items are summarised on one line; their per-output detail hasn't changed.
    if (item.status !== "cached") {
      for (const out of item.outputs) {
        lines.push(outputLine(out, item.sourceBytes));
        if (out.status === "written") {
          written++;
          writtenBytes += out.bytes;
        }
      }
    }
    const bytes = servedBytes(item);
    if (bytes !== null) {
      servedSource += item.sourceBytes;
      served += bytes;
    }
  }

  lines.push("");
  const parts = [`${plural(written, "file")} written`];
  if (written > 0) parts[0] += ` (${formatBytes(writtenBytes)} across all widths)`;
  if (unchangedItems > 0) parts.push(`${plural(unchangedItems, "image")} unchanged`);
  lines.push(`Total: ${parts.join(", ")}`);
  if (servedSource > 0) {
    lines.push(
      `Largest size per image: ${formatBytes(servedSource)} → ${formatBytes(served)} (${percentChange(servedSource, served)})`,
    );
  }
  if (result.cancelled) lines.push("Cancelled: no partial files were left behind.");
  return lines.join("\n");
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "";
  const lines = ["Project:"];
  for (const f of findings) {
    const where = f.path ? `${f.source ?? ""} → ${f.path}` : (f.source ?? "");
    lines.push(`  ${f.severity.padEnd(5)} ${f.ruleId}  ${where}: ${f.message}`);
  }
  return lines.join("\n");
}

const SEVERITY_ORDER: Record<string, number> = { error: 0, warn: 1, info: 2 };

export interface AuditFormatOptions {
  /** Show every finding instead of the first few per rule. */
  all?: boolean;
  perRule?: number;
}

/** Human report: findings grouped by rule with estimated savings, then a summary. */
export function formatAuditReport(report: AuditReport, options: AuditFormatOptions = {}): string {
  const limit = options.all ? Infinity : (options.perRule ?? 10);
  const groups = new Map<string, Finding[]>();
  for (const f of report.findings) groups.set(f.ruleId, [...(groups.get(f.ruleId) ?? []), f]);

  const ordered = [...groups.entries()].sort(([ida, a], [idb, b]) => {
    const sa = SEVERITY_ORDER[a[0]!.severity] ?? 9;
    const sb = SEVERITY_ORDER[b[0]!.severity] ?? 9;
    return sa - sb || (ida < idb ? -1 : 1);
  });

  const lines: string[] = [];
  for (const [ruleId, findings] of ordered) {
    const saved = findings.reduce((sum, f) => sum + (f.savingsBytes ?? 0), 0);
    const head = `${ruleId}  ${findings[0]!.severity}  ${plural(findings.length, "file")}`;
    lines.push(saved > 0 ? `${head} · est. save ${formatBytes(saved)}` : head);

    for (const f of findings.slice(0, limit)) {
      const where = f.path ? `${f.source} → ${f.path}` : (f.source ?? "(project)");
      const size =
        f.current !== undefined && f.estimated !== undefined
          ? `${formatBytes(f.current)} → ~${formatBytes(f.estimated)} (${percentChange(f.current, f.estimated)})`
          : f.current !== undefined
            ? formatBytes(f.current)
            : "";
      lines.push(`  ${where}${size ? `  ${size}` : ""}`);
      lines.push(`    ${f.message}`);
    }
    if (findings.length > limit) {
      lines.push(`  … and ${findings.length - limit} more (use --all)`);
    }
    lines.push("");
  }

  const { counts, totals } = report;
  const assets = [
    plural(counts.images + counts.skipped, "image"),
    plural(counts.svgs, "SVG"),
    plural(counts.videos, "video"),
  ].join(", ");
  lines.push(`Scanned ${assets} (${formatBytes(totals.sourceBytes)} of images).`);

  const by = (s: string) => report.findings.filter((f) => f.severity === s).length;
  lines.push(
    `${plural(report.findings.length, "finding")}: ${plural(by("error"), "error")}, ${plural(by("warn"), "warning")}, ${by("info")} info.`,
  );
  if (totals.optimizedImages > 0) {
    lines.push(`${plural(totals.optimizedImages, "image")} already optimized.`);
  }
  if (totals.potentialSavingsBytes > 0) {
    lines.push(
      `Estimated savings from optimizing: ~${formatBytes(totals.potentialSavingsBytes)} of ${formatBytes(totals.sourceBytes)} (${percentChange(totals.sourceBytes, totals.sourceBytes - totals.potentialSavingsBytes)}). Run \`bytecut optimize -y\` to apply.`,
    );
  }
  for (const note of report.notes) lines.push(`Note: ${note}`);
  return lines.join("\n");
}

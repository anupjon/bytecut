import { describe, expect, it } from "vitest";
import type { AuditReport, FileSummary } from "../../../src/core/commands/audit.js";
import type { Finding } from "../../../src/core/audit/types.js";
import { buildModel, defaultSelection, selectionTotals } from "../../../src/tui/model.js";

const file = (source: string, over: Partial<FileSummary> = {}): FileSummary => ({
  source,
  bytes: 100_000,
  width: 2000,
  height: 1000,
  format: "jpeg",
  preset: "photo",
  reason: "continuous-tone image",
  covered: false,
  estimatedBytes: 10_000,
  savingsBytes: 90_000,
  plannedOutputs: 6,
  ...over,
});

const finding = (
  ruleId: string,
  source: string | undefined,
  severity: Finding["severity"] = "warn",
): Finding => ({
  ruleId,
  severity,
  ...(source ? { source } : {}),
  message: `${ruleId} on ${source}`,
});

const report = (files: FileSummary[], findings: Finding[]): AuditReport => ({
  findings,
  files,
  counts: { images: files.length, svgs: 0, videos: 0, skipped: 0 },
  totals: { sourceBytes: 0, potentialSavingsBytes: 0, optimizedImages: 0 },
  notes: ["a note"],
});

describe("buildModel", () => {
  it("makes a row per file with a fixable finding and separates report-only findings", () => {
    const m = buildModel(
      report(
        [file("a.jpg"), file("b.jpg")],
        [
          finding("image/no-modern-format", "a.jpg"),
          finding("image/metadata", "a.jpg", "info"),
          finding("project/unreferenced", "b.jpg", "info"),
          finding("svg/unminified", "icons/x.svg"),
          finding("project/over-budget", undefined, "error"),
        ],
      ),
    );
    expect(m.rows.map((r) => r.source)).toEqual(["a.jpg"]);
    expect(m.rows[0]!.findings.map((f) => f.ruleId)).toEqual([
      "image/no-modern-format",
      "image/metadata",
    ]);
    expect(m.reportOnly.map((f) => f.ruleId).sort()).toEqual([
      "project/over-budget",
      "project/unreferenced",
      "svg/unminified",
    ]);
    expect(m.notes).toEqual(["a note"]);
  });

  it("takes the highest severity as the row's severity", () => {
    const m = buildModel(
      report(
        [file("a.jpg")],
        [finding("image/metadata", "a.jpg", "info"), finding("image/heavy", "a.jpg", "error")],
      ),
    );
    expect(m.rows[0]!.severity).toBe("error");
  });

  it("orders rows by estimated saving, biggest first, then path", () => {
    const m = buildModel(
      report(
        [
          file("small.jpg", { savingsBytes: 1_000 }),
          file("big.jpg", { savingsBytes: 500_000 }),
          file("b.jpg", { savingsBytes: 1_000 }),
        ],
        ["small.jpg", "big.jpg", "b.jpg"].map((s) => finding("image/no-modern-format", s)),
      ),
    );
    expect(m.rows.map((r) => r.source)).toEqual(["big.jpg", "b.jpg", "small.jpg"]);
  });

  it("omits already-optimized files from the rows but counts them", () => {
    const m = buildModel(
      report(
        [file("done.jpg", { covered: true }), file("todo.jpg")],
        [
          finding("image/no-modern-format", "done.jpg"),
          finding("image/no-modern-format", "todo.jpg"),
        ],
      ),
    );
    expect(m.rows.map((r) => r.source)).toEqual(["todo.jpg"]);
    expect(m.covered).toBe(1);
  });

  it("never offers files that cannot be processed, and lists them with the reason", () => {
    const m = buildModel(
      report(
        [file("loader.gif", { skipped: "animated GIF", preset: "-" })],
        [finding("gif/animated", "loader.gif"), finding("image/no-modern-format", "loader.gif")],
      ),
    );
    expect(m.rows).toEqual([]);
    expect(m.skipped).toEqual([{ source: "loader.gif", reason: "animated GIF" }]);
    expect(m.reportOnly).toHaveLength(2);
  });

  it("treats stale-output as fixable and orphaned-output as report-only", () => {
    const m = buildModel(
      report(
        [file("a.jpg")],
        [
          finding("project/stale-output", "a.jpg"),
          finding("project/orphaned-output", "a.jpg", "info"),
        ],
      ),
    );
    expect(m.rows.map((r) => r.source)).toEqual(["a.jpg"]);
    expect(m.reportOnly.map((f) => f.ruleId)).toEqual(["project/orphaned-output"]);
  });
});

describe("selection", () => {
  const m = buildModel(
    report(
      [file("warn.jpg"), file("info.jpg"), file("err.jpg", { savingsBytes: 5_000 })],
      [
        finding("image/no-modern-format", "warn.jpg", "warn"),
        finding("image/metadata", "info.jpg", "info"),
        finding("image/heavy", "err.jpg", "error"),
      ],
    ),
  );

  it("selects warn and above by default and leaves info unselected (§4)", () => {
    expect([...defaultSelection(m.rows)].sort()).toEqual(["err.jpg", "warn.jpg"]);
  });

  it("totals only the selected rows", () => {
    const t = selectionTotals(m.rows, new Set(["warn.jpg", "err.jpg"]));
    expect(t).toEqual({ count: 2, bytes: 200_000, savings: 95_000 });
    expect(selectionTotals(m.rows, new Set())).toEqual({ count: 0, bytes: 0, savings: 0 });
  });
});

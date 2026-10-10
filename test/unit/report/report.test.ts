import { describe, expect, it } from "vitest";
import type { Finding } from "../../../src/core/audit/types.js";
import type { AuditReport } from "../../../src/core/commands/audit.js";
import { evaluate } from "../../../src/core/commands/check.js";
import { renderJsonReport } from "../../../src/core/report/json.js";
import { MARKDOWN_LIMIT, renderMarkdownReport } from "../../../src/core/report/markdown.js";

const report = (findings: Finding[], over: Partial<AuditReport> = {}): AuditReport => ({
  findings,
  unprobed: [],
  files: [],
  counts: { images: 12, svgs: 1, videos: 0, skipped: 0 },
  totals: { sourceBytes: 3_200_000, potentialSavingsBytes: 0, optimizedImages: 0 },
  notes: [],
  ...over,
});

const FINDINGS: Finding[] = [
  {
    ruleId: "image/heavy",
    severity: "warn",
    source: "public/img/hero.jpg",
    message: "large for the web",
    current: 2_000_000,
    estimated: 300_000,
  },
  { ruleId: "project/over-budget", severity: "error", message: "total over the budget" },
];

describe("markdown report", () => {
  it("is a stable PR comment: verdict, summary, a table per rule, errors first", () => {
    const md = renderMarkdownReport(report(FINDINGS), evaluate(report(FINDINGS)));
    expect(md).toBe(
      [
        "## bytecut check: failed",
        "",
        "1 error, 1 warning, 0 info · scanned 12 images, 1 SVG, 0 videos (3.05 MB)",
        "",
        "Failing on errors: 1 finding.",
        "",
        "### `project/over-budget` · error · 1 file",
        "",
        "| File | Size | Detail |",
        "| --- | --- | --- |",
        "| (project) |  | total over the budget |",
        "",
        "### `image/heavy` · warn · 1 file",
        "",
        "| File | Size | Detail |",
        "| --- | --- | --- |",
        "| public/img/hero.jpg | 1.91 MB → ~293.0 KB (-85%) | large for the web |",
        "",
      ].join("\n"),
    );
  });

  it("says passed, and names the base when --changed was used", () => {
    const verdict = evaluate(report([]), {
      changed: { base: "origin/main", files: new Set(["a.jpg", "b.jpg"]), all: false },
    });
    const md = renderMarkdownReport(report([]), verdict);
    expect(md).toContain("## bytecut check: passed");
    expect(md).toContain("2 files changed since `origin/main`");
  });

  it("escapes file names and messages so a table cannot be broken or turned into markup", () => {
    const hostile: Finding = {
      ruleId: "image/heavy",
      severity: "warn",
      source: "img/a|b `c` <script>[x](y).jpg",
      message: "line one\nline two | *bold*",
    };
    const md = renderMarkdownReport(report([hostile]), evaluate(report([hostile])));
    const row = md.split("\n").find((l) => l.startsWith("| img/"))!;
    expect(row).not.toContain("<script>");
    expect(row).toContain("a\\|b");
    // The row is still exactly three cells.
    expect(row.replace(/\\\|/g, "").match(/\|/g)).toHaveLength(4);
    expect(row).not.toContain("\n");
  });

  it("limits each rule's rows and the whole comment, and says what was left out", () => {
    const many: Finding[] = Array.from({ length: 40 }, (_, i) => ({
      ruleId: "image/heavy",
      severity: "warn" as const,
      source: `img/${i}.jpg`,
      message: "m",
    }));
    const md = renderMarkdownReport(report(many), evaluate(report(many)));
    expect(md).toContain("… and 20 more.");

    const rules = Array.from({ length: 400 }, (_, r) =>
      Array.from({ length: 20 }, (_, i) => ({
        ruleId: `image/rule-${r}`,
        severity: "warn" as const,
        source: `img/${r}-${i}-${"x".repeat(80)}.jpg`,
        message: "m".repeat(80),
      })),
    ).flat();
    const big = renderMarkdownReport(report(rules), evaluate(report(rules)));
    expect(big.length).toBeLessThan(MARKDOWN_LIMIT);
    expect(big).toMatch(/more findings? not shown: this comment hit its size limit/);
  });

  it("surfaces videos that could not be analysed instead of passing silently", () => {
    const md = renderMarkdownReport(
      report([], { unprobed: [{ source: "v.mp4", bytes: 1 }], notes: ["something happened"] }),
      evaluate(report([])),
    );
    expect(md).toContain("> 1 video not analysed because ffmpeg was not found.");
    expect(md).toContain("> something happened");
  });
});

describe("json report", () => {
  it("has a stable shape", () => {
    const parsed = JSON.parse(renderJsonReport(report(FINDINGS), evaluate(report(FINDINGS))));
    expect(Object.keys(parsed)).toEqual([
      "version",
      "ok",
      "failOn",
      "counts",
      "changed",
      "findings",
      "failing",
      "scanned",
      "totals",
      "unprobed",
      "notes",
    ]);
    expect(parsed).toMatchObject({
      version: 1,
      ok: false,
      failOn: "error",
      counts: { error: 1, warn: 1, info: 0 },
      changed: null,
      failing: 1,
    });
    expect(parsed.findings).toHaveLength(2);
  });
});

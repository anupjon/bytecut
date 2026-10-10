import { describe, expect, it } from "vitest";
import type { Finding } from "../../../src/core/audit/types.js";
import type { AuditReport } from "../../../src/core/commands/audit.js";
import { evaluate } from "../../../src/core/commands/check.js";
import type { ChangedFiles } from "../../../src/core/git/changed.js";

const finding = (over: Partial<Finding> & Pick<Finding, "ruleId" | "severity">): Finding => ({
  message: "m",
  ...over,
});

const report = (findings: Finding[]): AuditReport => ({
  findings,
  unprobed: [],
  files: [],
  counts: { images: 3, svgs: 0, videos: 0, skipped: 0 },
  totals: { sourceBytes: 3000, potentialSavingsBytes: 0, optimizedImages: 0 },
  notes: [],
});

const changed = (files: string[], all = false): ChangedFiles => ({
  base: "origin/main",
  files: new Set(files),
  all,
});

const FINDINGS = [
  finding({ ruleId: "project/over-budget", severity: "error", source: "a.jpg" }),
  finding({ ruleId: "image/heavy", severity: "warn", source: "b.jpg" }),
  finding({ ruleId: "image/metadata", severity: "info", source: "c.jpg" }),
  finding({ ruleId: "project/over-budget", severity: "error" }), // project-level
];

describe("evaluate", () => {
  it("passes with no findings", () => {
    expect(evaluate(report([])).ok).toBe(true);
  });

  it("fails on an error, passes on warnings and info alone", () => {
    expect(evaluate(report(FINDINGS)).ok).toBe(false);
    expect(evaluate(report(FINDINGS.filter((f) => f.severity !== "error"))).ok).toBe(true);
  });

  it("--fail-on warn also fails on warnings, never on info", () => {
    const warnOnly = report(FINDINGS.filter((f) => f.severity === "warn"));
    expect(evaluate(warnOnly).ok).toBe(true);
    expect(evaluate(warnOnly, { failOn: "warn" }).ok).toBe(false);
    const infoOnly = report(FINDINGS.filter((f) => f.severity === "info"));
    expect(evaluate(infoOnly, { failOn: "warn" }).ok).toBe(true);
  });

  it("counts severities and lists what fails", () => {
    const v = evaluate(report(FINDINGS));
    expect(v.counts).toEqual({ error: 2, warn: 1, info: 1 });
    expect(v.failing).toHaveLength(2);
    expect(v.scope).toBeNull();
  });

  describe("--changed", () => {
    it("keeps findings about changed files and project-level findings, drops the rest", () => {
      const v = evaluate(report(FINDINGS), { changed: changed(["b.jpg"]) });
      expect(v.findings.map((f) => `${f.ruleId}:${f.source ?? "-"}`)).toEqual([
        "image/heavy:b.jpg",
        "project/over-budget:-",
      ]);
      expect(v.scope).toEqual({
        base: "origin/main",
        changedFiles: 1,
        everything: false,
        dropped: 2,
      });
      // The error on unchanged a.jpg no longer decides the verdict; the project-level one still does.
      expect(v.ok).toBe(false);
    });

    it("an error on an unchanged file does not fail the check", () => {
      const only = report([
        finding({ ruleId: "project/over-budget", severity: "error", source: "a.jpg" }),
      ]);
      expect(evaluate(only, { changed: changed(["other.jpg"]) }).ok).toBe(true);
      expect(evaluate(only, { changed: changed(["a.jpg"]) }).ok).toBe(false);
    });

    it("a changed config puts everything in scope", () => {
      const v = evaluate(report(FINDINGS), { changed: changed([], true) });
      expect(v.findings).toHaveLength(4);
      expect(v.scope).toMatchObject({ everything: true, dropped: 0 });
    });
  });
});

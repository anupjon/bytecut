import { describe, expect, it } from "vitest";
import { runProjectRules } from "../../../src/core/audit/run.js";
import { orphanedOutput } from "../../../src/core/audit/rules/orphaned-output.js";
import { staleOutput } from "../../../src/core/audit/rules/stale-output.js";
import type { ProjectContext } from "../../../src/core/audit/types.js";
import type { Manifest, ManifestOutput } from "../../../src/core/manifest/types.js";
import type { PlanItem } from "../../../src/core/plan/types.js";

const H = "a".repeat(64);
const OUT = "b".repeat(64);

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  source: "a.jpg",
  sourceBytes: 1000,
  sourceSha256: H,
  sourceWidth: 800,
  sourceHeight: 600,
  preset: "photo",
  outputs: [
    { path: "a/a-640.avif", format: "avif", width: 640, lossless: false, quality: 60, effort: 4 },
  ],
  ...over,
});

const output = (over: Partial<ManifestOutput> = {}): ManifestOutput => ({
  path: "a/a-640.avif",
  url: "/_bytecut/a/a-640.avif",
  format: "avif",
  width: 640,
  height: 480,
  bytes: 10,
  sha256: OUT,
  lossless: false,
  quality: 60,
  effort: 4,
  encoder: "libaom-av1 3.15.1",
  status: "written",
  ...over,
});

const manifest = (sources: Manifest["sources"]): Manifest => ({
  version: 2,
  tools: {},
  publicPath: "/_bytecut",
  sources,
});

const entry = (over: Partial<Manifest["sources"][string]> = {}) => ({
  sha256: H,
  bytes: 1000,
  width: 800,
  height: 600,
  preset: "photo",
  outputs: [output()],
  ...over,
});

function ctx(over: Partial<ProjectContext> & { items?: PlanItem[] }): ProjectContext {
  return {
    plan: { version: 1, outDir: "out", publicPath: "/_bytecut", items: over.items ?? [item()] },
    manifest: null,
    encoders: { avif: "libaom-av1 3.15.1", webp: "libwebp 1.6.0" },
    sourceExists: async () => true,
    outputHash: async () => OUT,
    ...over,
  };
}

describe("project/stale-output", () => {
  it("has the rule shape from the spec", () => {
    expect(staleOutput).toMatchObject({ id: "project/stale-output", defaultSeverity: "warn" });
    expect(orphanedOutput).toMatchObject({
      id: "project/orphaned-output",
      defaultSeverity: "info",
    });
  });

  it("reports nothing without a manifest or for new sources", async () => {
    expect(await staleOutput.check(ctx({}))).toEqual([]);
    expect(await staleOutput.check(ctx({ manifest: manifest({}) }))).toEqual([]);
  });

  it("reports nothing when everything is current", async () => {
    expect(await staleOutput.check(ctx({ manifest: manifest({ "a.jpg": entry() }) }))).toEqual([]);
  });

  it.each([
    [
      "source changed",
      () => ({ manifest: manifest({ "a.jpg": entry({ sha256: "c".repeat(64) }) }) }),
      /source changed/,
    ],
    [
      "preset differs",
      () => ({ manifest: manifest({ "a.jpg": entry({ preset: "hero" }) }) }),
      /preset or widths differ/,
    ],
    [
      "output missing",
      () => ({ manifest: manifest({ "a.jpg": entry() }), outputHash: async () => null }),
      /missing/,
    ],
    [
      "output modified",
      () => ({ manifest: manifest({ "a.jpg": entry() }), outputHash: async () => "d".repeat(64) }),
      /modified.*left alone unless you use --force/,
    ],
    [
      "output stale",
      () => ({
        manifest: manifest({ "a.jpg": entry({ outputs: [output({ status: "stale" })] }) }),
      }),
      /older source/,
    ],
  ] as const)("reports %s", async (_name, make, message) => {
    const findings = await staleOutput.check(ctx(make() as Partial<ProjectContext>));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "project/stale-output",
      severity: "warn",
      source: "a.jpg",
    });
    expect(findings[0]!.message).toMatch(message);
  });

  it("reports encoder drift without claiming it will regenerate", async () => {
    const m = manifest({ "a.jpg": entry({ outputs: [output({ encoder: "libaom-av1 3.9.0" })] }) });
    const findings = await staleOutput.check(ctx({ manifest: m }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toMatch(/3\.9\.0.*3\.15\.1.*--force/);
  });

  it("ignores plan-skipped items", async () => {
    const skipped = item({ skip: { reason: "animated image" }, outputs: [] });
    const m = manifest({ "a.jpg": entry({ sha256: "c".repeat(64) }) });
    expect(await staleOutput.check(ctx({ manifest: m, items: [skipped] }))).toEqual([]);
  });
});

describe("project/orphaned-output", () => {
  it("reports outputs whose source no longer exists", async () => {
    const m = manifest({ "gone.jpg": entry() });
    const findings = await orphanedOutput.check(
      ctx({ manifest: m, items: [], sourceExists: async () => false }),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        source: "gone.jpg",
        path: "a/a-640.avif",
        message: "source no longer exists",
        severity: "info",
      }),
    ]);
  });

  it("reports outputs the current plan no longer produces", async () => {
    const m = manifest({
      "a.jpg": entry({ outputs: [output(), output({ path: "a/a-300.avif", width: 300 })] }),
    });
    const findings = await orphanedOutput.check(ctx({ manifest: m }));
    expect(findings.map((f) => f.path)).toEqual(["a/a-300.avif"]);
  });

  it("does not judge sources outside this run's scope when their file exists", async () => {
    const m = manifest({ "elsewhere.jpg": entry() });
    expect(await orphanedOutput.check(ctx({ manifest: m }))).toEqual([]);
  });
});

describe("runProjectRules", () => {
  it("returns a stable, sorted list", async () => {
    const m = manifest({
      "z.jpg": entry(),
      "a.jpg": entry({ sha256: "c".repeat(64) }),
    });
    const findings = await runProjectRules(
      ctx({ manifest: m, sourceExists: async (s) => s !== "z.jpg" }),
    );
    const ids = findings.map((f) => `${f.ruleId}:${f.source}`);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain("project/stale-output:a.jpg");
    expect(ids).toContain("project/orphaned-output:z.jpg");
  });
});

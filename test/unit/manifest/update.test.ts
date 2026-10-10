import { describe, expect, it } from "vitest";
import type { ItemResult, OutputResult, RunResult } from "../../../src/core/execute/run.js";
import { outputUrl, updateManifest } from "../../../src/core/manifest/update.js";
import type { Manifest } from "../../../src/core/manifest/types.js";
import type { Plan, PlanItem } from "../../../src/core/plan/types.js";

const S1 = "1".repeat(64);
const S2 = "2".repeat(64);
const O = (c: string) => c.repeat(64);

const planItem = (paths: string[]): PlanItem => ({
  source: "a.jpg",
  sourceBytes: 1000,
  sourceSha256: S2,
  sourceWidth: 800,
  sourceHeight: 600,
  preset: "photo",
  outputs: paths.map((path) => ({
    path,
    format: "avif" as const,
    width: 640,
    lossless: false,
    quality: 60,
    effort: 4,
  })),
});

const plan = (item: PlanItem, publicPath = "/_bytecut"): Plan => ({
  version: 1,
  outDir: "out",
  publicPath,
  items: [item],
});

const out = (path: string, status: OutputResult["status"], hash = O("e")): OutputResult => ({
  path,
  format: "avif",
  width: 640,
  height: 480,
  bytes: 100,
  lossless: false,
  quality: 60,
  effort: 4,
  sha256: hash,
  encoder: "enc 1",
  status,
});

const result = (outputs: OutputResult[], status: ItemResult["status"] = "done"): RunResult => ({
  cancelled: false,
  warnings: [],
  items: [
    {
      source: "a.jpg",
      sourceBytes: 1000,
      sourceSha256: S2,
      sourceWidth: 800,
      sourceHeight: 600,
      preset: "photo",
      status,
      outputs,
    },
  ],
});

const previous: Manifest = {
  version: 2,
  tools: {},
  publicPath: "/_bytecut",
  sources: {
    "a.jpg": {
      sha256: S1,
      bytes: 900,
      width: 800,
      height: 600,
      preset: "photo",
      outputs: [
        { ...out("old/x.avif", "written", O("d")), url: "/_bytecut/old/x.avif", status: "written" },
        { ...out("a/a.avif", "written", O("d")), url: "/_bytecut/a/a.avif", status: "written" },
      ] as never,
    },
    "other.jpg": { sha256: S1, bytes: 1, width: 1, height: 1, preset: "photo", outputs: [] },
  },
};

describe("updateManifest", () => {
  it("records new outputs with url, hash, encoder and status", () => {
    const next = updateManifest(
      null,
      plan(planItem(["a/a.avif"])),
      result([out("a/a.avif", "written")]),
      {
        bytecut: "1",
      },
    );
    expect(next.tools).toEqual({ bytecut: "1" });
    expect(next.sources["a.jpg"]).toMatchObject({
      sha256: S2,
      preset: "photo",
      outputs: [
        {
          path: "a/a.avif",
          url: "/_bytecut/a/a.avif",
          sha256: O("e"),
          encoder: "enc 1",
          status: "written",
        },
      ],
    });
  });

  it("keeps entries for sources outside the run", () => {
    const next = updateManifest(
      previous,
      plan(planItem(["a/a.avif"])),
      result([out("a/a.avif", "written")]),
      {},
    );
    expect(next.sources["other.jpg"]).toBe(previous.sources["other.jpg"]);
  });

  it("keeps outputs the plan no longer produces so they stay deletable", () => {
    const next = updateManifest(
      previous,
      plan(planItem(["a/a.avif"])),
      result([out("a/a.avif", "written")]),
      {},
    );
    expect(next.sources["a.jpg"]!.outputs.map((o) => o.path)).toEqual(["a/a.avif", "old/x.avif"]);
  });

  it("records already-optimal outputs without a hash", () => {
    const o = out("a/a.avif", "already-optimal");
    delete o.sha256;
    const next = updateManifest(null, plan(planItem(["a/a.avif"])), result([o]), {});
    const rec = next.sources["a.jpg"]!.outputs[0]!;
    expect(rec.status).toBe("already-optimal");
    expect(rec).not.toHaveProperty("sha256");
  });

  it("marks a planned output stale when its source changed and it was not regenerated", () => {
    const next = updateManifest(
      previous,
      plan(planItem(["a/a.avif", "a/b.avif"])),
      result([out("a/a.avif", "failed"), out("a/b.avif", "written")], "failed"),
      {},
    );
    const byPath = Object.fromEntries(next.sources["a.jpg"]!.outputs.map((o) => [o.path, o]));
    expect(byPath["a/a.avif"]!.status).toBe("stale");
    expect(byPath["a/b.avif"]!.status).toBe("written");
    expect(next.sources["a.jpg"]!.sha256).toBe(S2);
  });

  it("keeps an old output valid when the source did not change", () => {
    const same: Manifest = {
      ...previous,
      sources: { ...previous.sources, "a.jpg": { ...previous.sources["a.jpg"]!, sha256: S2 } },
    };
    const next = updateManifest(
      same,
      plan(planItem(["a/a.avif", "a/b.avif"])),
      result([out("a/a.avif", "failed"), out("a/b.avif", "written")], "failed"),
      {},
    );
    const a = next.sources["a.jpg"]!.outputs.find((o) => o.path === "a/a.avif")!;
    expect(a.status).toBe("written");
    expect(a.sha256).toBe(O("d"));
  });

  it("leaves the old entry alone when nothing was produced", () => {
    const next = updateManifest(
      previous,
      plan(planItem(["a/a.avif"])),
      result([out("a/a.avif", "protected")], "done"),
      {},
    );
    expect(next.sources["a.jpg"]).toBe(previous.sources["a.jpg"]);
  });

  it("ignores cached and skipped items", () => {
    const r = result([], "cached");
    expect(updateManifest(previous, plan(planItem([])), r, {}).sources["a.jpg"]).toBe(
      previous.sources["a.jpg"],
    );
  });

  it("does not mutate the previous manifest and refreshes URLs for a new public path", () => {
    const snapshot = JSON.stringify(previous);
    const next = updateManifest(
      previous,
      plan(planItem(["a/a.avif"]), "/img/"),
      result([out("a/a.avif", "written")]),
      {},
    );
    expect(JSON.stringify(previous)).toBe(snapshot);
    expect(next.publicPath).toBe("/img/");
    expect(next.sources["a.jpg"]!.outputs.every((o) => o.url.startsWith("/img/"))).toBe(true);
    expect(outputUrl("/img/", "a/b.avif")).toBe("/img/a/b.avif");
  });
});

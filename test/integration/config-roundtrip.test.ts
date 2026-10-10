import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeImageFixtures } from "../../scripts/make-fixtures.js";
import { optimize } from "../../src/core/commands/optimize.js";
import { loadConfig } from "../../src/core/config/load.js";
import { resolveConfig } from "../../src/core/config/resolve.js";
import { sharpImageEngine } from "../../src/core/engines/image.js";
import { svgoEngine } from "../../src/core/engines/svg.js";
import type { Plan } from "../../src/core/plan/types.js";
import { createSession } from "../../src/tui/session.js";
import { hashAll, tempDir } from "../helpers.js";

let fixtures: string;
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "bytecut-roundtrip-fixtures-"));
  await makeImageFixtures(fixtures);
});
afterAll(() => rm(fixtures, { recursive: true, force: true }));

async function project(): Promise<string> {
  const root = await tempDir();
  await mkdir(join(root, "public/img"), { recursive: true });
  for (const [i, name] of ["a.jpg", "b.jpg", "c.jpg"].entries()) {
    const data = await sharp(join(fixtures, "photo.jpg"))
      .resize(700 + i * 40)
      .jpeg({ quality: 85 })
      .toBuffer();
    await writeFile(join(root, "public/img", name), data);
  }
  await cp(join(fixtures, "small.jpg"), join(root, "public/img/small[1].jpg"));
  return root;
}

async function sessionFor(root: string) {
  const config = await resolveConfig(root, await loadConfig(root));
  return createSession({
    projectRoot: root,
    engine: sharpImageEngine,
    svgEngine: svgoEngine,
    project: config.project,
    config,
    inputs: ["public"],
    toolVersion: "test",
    ffmpeg: { found: false, installHint: "" },
    concurrency: 1,
  });
}

/** What actually gets executed: the plan without the human-readable reason for each choice. */
const executable = (plan: Plan) => ({
  ...plan,
  items: plan.items.map((item) => {
    const { classification, ...rest } = item;
    void classification;
    return rest;
  }),
});

describe("TUI choices → written config → identical plan", () => {
  it("a saved per-file preset and output folder reproduce the same plan with no overrides", async () => {
    const root = await project();
    const choices = {
      outDir: "public/optimized",
      presets: { "public/img/a.jpg": "icon", "public/img/small[1].jpg": "hero" },
    };
    const common = {
      projectRoot: root,
      engine: sharpImageEngine,
      toolVersion: "test",
      inputs: ["public"],
      staticRoot: "public",
      execute: false,
    };

    const before = (
      await optimize({
        ...common,
        outDir: choices.outDir,
        presetOverrides: choices.presets,
      })
    ).plan;
    expect(before.items.find((i) => i.source === "public/img/a.jpg")!.preset).toBe("icon");

    const session = await sessionFor(root);
    expect(await session.saveChoices(choices)).toEqual({
      kind: "written",
      file: "bytecut.config.json",
      created: true,
    });

    // Only the choices are in the file: nothing else is written.
    expect(JSON.parse(await readFile(join(root, "bytecut.config.json"), "utf8"))).toEqual({
      outDir: "public/optimized",
      assets: { "public/img/a.jpg": "icon", "public/img/small\\[1\\].jpg": "hero" },
    });

    const config = await resolveConfig(root, await loadConfig(root));
    const after = (
      await optimize({
        ...common,
        outDir: config.project.outDir,
        policy: config.policy,
      })
    ).plan;

    expect(executable(after)).toEqual(executable(before));
  });

  it("a run made with the overrides is a full cache hit under the saved config", async () => {
    const root = await project();
    const presets = { "public/img/b.jpg": "icon" };
    const common = {
      projectRoot: root,
      engine: sharpImageEngine,
      toolVersion: "test",
      inputs: ["public/img/b.jpg", "public/img/c.jpg"],
      staticRoot: "public",
      outDir: "public/_bytecut",
    };
    const first = await optimize({ ...common, presetOverrides: presets, execute: true });
    expect(first.result!.items.every((i) => i.status === "done")).toBe(true);

    await (await sessionFor(root)).saveChoices({ presets });
    const config = await resolveConfig(root, await loadConfig(root));
    const second = await optimize({ ...common, policy: config.policy, execute: true });
    expect(second.result!.items.map((i) => i.status)).toEqual(["cached", "cached"]);
  });

  it("later saves add to the file instead of replacing it, newest rule first", async () => {
    const root = await project();
    await writeFile(
      join(root, "bytecut.config.json"),
      JSON.stringify({ budgets: { maxFileSize: "1 MB" }, assets: { "public/img/*.jpg": "photo" } }),
    );
    const session = await sessionFor(root);
    await session.saveChoices({ presets: { "public/img/a.jpg": "icon" } });
    await session.saveChoices({ presets: { "public/img/b.jpg": "hero" } });

    const written = JSON.parse(await readFile(join(root, "bytecut.config.json"), "utf8"));
    expect(written.budgets).toEqual({ maxFileSize: "1 MB" });
    expect(Object.entries(written.assets)).toEqual([
      ["public/img/b.jpg", "hero"],
      ["public/img/a.jpg", "icon"],
      ["public/img/*.jpg", "photo"],
    ]);
    const config = await resolveConfig(root, await loadConfig(root));
    expect(config.policy.assetFor("public/img/a.jpg")!.preset).toBe("icon");
    expect(config.policy.assetFor("public/img/c.jpg")!.preset).toBe("photo");
  });

  it("never rewrites a TypeScript or TOML config; it hands back what to add", async () => {
    for (const [name, content] of [
      ["bytecut.config.ts", "// my comment\nexport default { outDir: 'public/x' };\n"],
      ["bytecut.config.toml", '# my comment\noutDir = "public/x"\n'],
    ] as const) {
      const root = await project();
      await writeFile(join(root, name), content);
      const session = await sessionFor(root);
      const outcome = await session.saveChoices({ presets: { "public/img/a.jpg": "icon" } });
      expect(outcome).toMatchObject({ kind: "manual", file: name });
      expect(outcome.kind === "manual" && outcome.snippet).toContain("public/img/a.jpg");
      expect(await readFile(join(root, name), "utf8")).toBe(content);
    }
  });

  it("reports a config it cannot update instead of corrupting it", async () => {
    const root = await project();
    const session = await sessionFor(root);
    // Broken after the session started, e.g. edited in another window.
    await writeFile(join(root, "bytecut.config.json"), "{ not json");
    const outcome = await session.saveChoices({ outDir: "x" });
    expect(outcome.kind).toBe("error");
    expect(await readFile(join(root, "bytecut.config.json"), "utf8")).toBe("{ not json");
  });

  it("precedence, low to high: classifier, assets rule, --preset, per-file choice", async () => {
    const root = await project();
    await writeFile(
      join(root, "bytecut.config.json"),
      JSON.stringify({ assets: { "public/img/a.jpg": "hero" } }),
    );
    const config = await resolveConfig(root, await loadConfig(root));
    const presetOf = async (extra: {
      presetOverride?: string;
      presetOverrides?: Record<string, string>;
    }) =>
      (
        await optimize({
          projectRoot: root,
          engine: sharpImageEngine,
          toolVersion: "test",
          inputs: ["public/img/a.jpg"],
          staticRoot: "public",
          outDir: "public/_bytecut",
          policy: config.policy,
          execute: false,
          ...extra,
        })
      ).plan.items[0]!.preset;

    expect(await presetOf({})).toBe("hero");
    expect(await presetOf({ presetOverride: "icon" })).toBe("icon");
    expect(
      await presetOf({
        presetOverride: "icon",
        presetOverrides: { "public/img/a.jpg": "photo" },
      }),
    ).toBe("photo");
  });

  it("saving does not touch sources", async () => {
    const root = await project();
    const names = ["a.jpg", "b.jpg", "c.jpg"];
    const before = await hashAll(join(root, "public/img"), names);
    await (await sessionFor(root)).saveChoices({ presets: { "public/img/a.jpg": "icon" } });
    expect(await hashAll(join(root, "public/img"), names)).toEqual(before);
  });
});

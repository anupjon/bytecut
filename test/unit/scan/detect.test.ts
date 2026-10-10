import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../../../src/core/scan/detect.js";
import { tempDir } from "../../helpers.js";

async function project(files: Record<string, string | null>) {
  const root = await tempDir();
  for (const [path, content] of Object.entries(files)) {
    if (content === null) await mkdir(join(root, path), { recursive: true });
    else await writeFile(join(root, path), content);
  }
  return root;
}

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
  JSON.stringify({ dependencies: deps, devDependencies: dev });

const PUBLIC_DEFAULTS = {
  include: ["public"],
  outDir: "public/_bytecut",
  publicPath: "/_bytecut",
  staticRoot: "public",
};

describe("detectProject", () => {
  it.each([
    ["next", { next: "15.0.0", react: "19" }],
    ["astro", { astro: "5.0.0" }],
    ["vite", { vite: "6.0.0" }],
  ] as const)("detects %s from dependencies", async (framework, deps) => {
    const root = await project({ "package.json": pkg(deps) });
    expect(await detectProject(root)).toEqual({
      framework,
      react: "react" in deps,
      ...PUBLIC_DEFAULTS,
    });
  });

  it("looks at devDependencies too", async () => {
    const root = await project({ "package.json": pkg({}, { vite: "6.0.0" }) });
    expect((await detectProject(root)).framework).toBe("vite");
  });

  it("detects from a config file when package.json is missing", async () => {
    const root = await project({ "astro.config.mjs": "export default {}" });
    expect((await detectProject(root)).framework).toBe("astro");
  });

  it.each([
    ["next", "next.config.ts"],
    ["vite", "vite.config.mts"],
  ] as const)("recognises %s config %s", async (framework, file) => {
    const root = await project({ [file]: "" });
    expect((await detectProject(root)).framework).toBe(framework);
  });

  it("prefers the more specific framework over vite", async () => {
    const root = await project({ "package.json": pkg({ astro: "5", vite: "6" }) });
    expect((await detectProject(root)).framework).toBe("astro");
    const next = await project({ "package.json": pkg({ next: "15", vite: "6" }) });
    expect((await detectProject(next)).framework).toBe("next");
  });

  it("static with a public folder uses it", async () => {
    const root = await project({ "index.html": "", public: null });
    expect(await detectProject(root)).toEqual({
      framework: "static",
      react: false,
      ...PUBLIC_DEFAULTS,
    });
  });

  it("static without a public folder scans the root into _bytecut", async () => {
    const root = await project({ "index.html": "" });
    expect(await detectProject(root)).toEqual({
      framework: "static",
      react: false,
      include: ["."],
      outDir: "_bytecut",
      publicPath: "/_bytecut",
      staticRoot: ".",
    });
  });

  it("records whether react is a dependency (decides JSX vs HTML under Vite)", async () => {
    const withReact = await project({ "package.json": pkg({ vite: "6", react: "19" }) });
    expect(await detectProject(withReact)).toMatchObject({ framework: "vite", react: true });
    const withVue = await project({ "package.json": pkg({ vite: "6", vue: "3" }) });
    expect(await detectProject(withVue)).toMatchObject({ framework: "vite", react: false });
    const devOnly = await project({ "package.json": pkg({}, { vite: "6", react: "19" }) });
    expect((await detectProject(devOnly)).react).toBe(true);
  });

  it("survives an unparseable package.json", async () => {
    const root = await project({ "package.json": "{ nope" });
    expect((await detectProject(root)).framework).toBe("static");
  });

  it("ignores a framework named only in an unrelated dependency", async () => {
    const root = await project({
      "package.json": pkg({ "next-themes": "1", "vite-plugin-x": "1" }),
    });
    expect((await detectProject(root)).framework).toBe("static");
  });
});

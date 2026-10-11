import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeImageFixtures } from "../../scripts/make-fixtures.js";
import { parseManifest } from "../../src/core/manifest/io.js";
import { hashAll, listFiles, tempDir } from "../helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");

let fixtures: string;
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "bytecut-config-fixtures-"));
  await makeImageFixtures(fixtures);
});
afterAll(() => rm(fixtures, { recursive: true, force: true }));

const cli = (cwd: string, args: string[]) =>
  execFileAsync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), join(repoRoot, "src/cli/index.ts"), ...args],
    { cwd },
  );
const fail = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected the command to fail");
    },
    (e: { code: number; stderr: string; stdout: string }) => e,
  );

/** A static-site project with two photos under public/img. */
async function project(files: Record<string, string> = {}) {
  const root = await tempDir();
  await mkdir(join(root, "public/img"), { recursive: true });
  await cp(join(fixtures, "small.jpg"), join(root, "public/img/small.jpg"));
  await cp(join(fixtures, "small.jpg"), join(root, "public/img/other.jpg"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

const dryPlan = async (root: string, extra: string[] = []) =>
  JSON.parse((await cli(root, ["optimize", "--dry-run", "--json", ...extra])).stdout) as {
    outDir: string;
    publicPath: string;
    items: Array<{
      source: string;
      preset: string;
      outputs: Array<{ path: string; format: string; width: number; quality: number }>;
    }>;
  };

describe("zero-config equivalence", () => {
  it("an empty config of every format produces the same plan as no config", async () => {
    const none = await dryPlan(await project());
    for (const [name, content] of [
      ["bytecut.config.json", "{}"],
      ["bytecut.config.toml", ""],
      ["bytecut.config.mjs", "export default {};\n"],
    ] as const) {
      const root = await project({ [name]: content });
      expect(await dryPlan(root), name).toEqual(none);
    }
  });
});

describe("config drives the plan", () => {
  const config = JSON.stringify({
    presets: {
      "small-photo": { extends: "photo", widths: [200], formats: ["webp"], quality: { webp: 50 } },
    },
    assets: { "public/img/small.jpg": "small-photo" },
  });

  it("applies an assets rule and a custom preset, and says why", async () => {
    const root = await project({ "bytecut.config.json": config });
    const plan = await dryPlan(root);
    const small = plan.items.find((i) => i.source === "public/img/small.jpg")!;
    const other = plan.items.find((i) => i.source === "public/img/other.jpg")!;
    expect(small.preset).toBe("small-photo");
    expect(small.outputs).toEqual([
      expect.objectContaining({
        path: "img/small/small-200.webp",
        format: "webp",
        width: 200,
        quality: 50,
      }),
    ]);
    // Files no rule matches still go through the classifier.
    expect(other.preset).not.toBe("small-photo");
    const text = (await cli(root, ["optimize", "--dry-run"])).stdout;
    expect(text).toMatch(/set to small-photo by assets "public\/img\/small\.jpg"/);
  });

  it("writes only what the preset asks for, records the preset, and leaves sources alone", async () => {
    const root = await project({ "bytecut.config.json": config });
    const before = await hashAll(join(root, "public/img"), ["small.jpg", "other.jpg"]);
    await cli(root, ["optimize", "-y"]);
    const files = await listFiles(join(root, "public/_bytecut/img/small"));
    expect(files).toEqual(["small-200.webp"]);
    const manifest = parseManifest(
      await readFile(join(root, "public/_bytecut/bytecut-manifest.json"), "utf8"),
    );
    expect(manifest.sources["public/img/small.jpg"]!.preset).toBe("small-photo");
    expect(await hashAll(join(root, "public/img"), ["small.jpg", "other.jpg"])).toEqual(before);
  });

  it("flags beat config: --preset and --out-dir", async () => {
    const root = await project({
      "bytecut.config.json": JSON.stringify({
        ...JSON.parse(config),
        outDir: "public/from-config",
      }),
    });
    expect((await dryPlan(root)).outDir).toBe("public/from-config");
    const flagged = await dryPlan(root, ["--out-dir", "public/from-flag", "--preset", "icon"]);
    expect(flagged.outDir).toBe("public/from-flag");
    expect(flagged.items.every((i) => i.preset === "icon")).toBe(true);
  });

  it("honours `framework`, which decides the snippet syntax", async () => {
    const root = await project({ "bytecut.config.json": JSON.stringify({ framework: "next" }) });
    await cli(root, ["optimize", "-y"]);
    const { stdout } = await cli(root, ["snippet", "public/img/small.jpg"]);
    // JSX, not HTML: the default is a single JPEG, so a self-closing <img> and a style object.
    expect(stdout).toMatch(/<img[^>]*\/>/);
    expect(stdout).toContain("style={{");
  });

  it("excludes files from directory scans with .gitignore syntax", async () => {
    const root = await project({ "bytecut.config.json": JSON.stringify({ exclude: ["other.*"] }) });
    const plan = await dryPlan(root);
    expect(plan.items.map((i) => i.source)).toEqual(["public/img/small.jpg"]);
    // Naming a file is an instruction, as with .gitignore.
    const named = await dryPlan(root, ["public/img/other.jpg"]);
    expect(named.items.map((i) => i.source)).toEqual(["public/img/other.jpg"]);
  });
});

describe("audit config", () => {
  const auditJson = async (root: string) =>
    JSON.parse((await cli(root, ["audit", "--json", "--no-cache"])).stdout) as {
      findings: Array<{ ruleId: string; severity: string; source?: string }>;
      files: Array<{ source: string }>;
    };

  it("turns a rule off and changes another's severity", async () => {
    const plain = await auditJson(await project());
    expect(plain.findings.some((f) => f.ruleId === "image/no-modern-format")).toBe(true);

    const root = await project({
      "bytecut.config.json": JSON.stringify({
        audit: { rules: { "image/no-modern-format": "off", "image/metadata": "error" } },
      }),
    });
    const configured = await auditJson(root);
    expect(configured.findings.some((f) => f.ruleId === "image/no-modern-format")).toBe(false);
    for (const f of configured.findings.filter((f) => f.ruleId === "image/metadata")) {
      expect(f.severity).toBe("error");
    }
  });

  it("applies budgets", async () => {
    const root = await project({
      "bytecut.config.json": JSON.stringify({ budgets: { maxFileSize: "1 B" } }),
    });
    const { findings } = await auditJson(root);
    const budget = findings.filter((f) => f.ruleId === "project/over-budget");
    expect(budget.length).toBeGreaterThan(0);
    expect(budget.every((f) => f.severity === "error")).toBe(true);
  });

  it("audit.ignore silences findings and hides the files from the list", async () => {
    const root = await project({
      "bytecut.config.json": JSON.stringify({ audit: { ignore: ["**/other.jpg"] } }),
    });
    const { findings, files } = await auditJson(root);
    expect(findings.some((f) => f.source === "public/img/other.jpg")).toBe(false);
    expect(findings.some((f) => f.source === "public/img/small.jpg")).toBe(true);
    expect(files.map((f) => f.source)).toEqual(["public/img/small.jpg"]);
  });
});

describe("bytecut explain", () => {
  const config = JSON.stringify({
    presets: { crisp: { extends: "photo", target: "high" } },
    assets: { "public/img/small.jpg": "crisp" },
    audit: { ignore: ["public/img/other.jpg"] },
  });

  it("names the rule that matched and what the preset resolves to", async () => {
    const root = await project({ "bytecut.config.json": config });
    const { stdout } = await cli(root, ["explain", "public/img/small.jpg"]);
    expect(stdout).toMatch(/Config: bytecut\.config\.json/);
    expect(stdout).toMatch(/preset:\s+crisp\s+\(from assets rule "public\/img\/small\.jpg"\)/);
    expect(stdout).toMatch(/extends:\s+photo → crisp/);
    expect(stdout).toMatch(/changed:\s+target/);
    expect(stdout).toMatch(/formats:\s+jpg/);
    expect(stdout).toMatch(/jpg:\s+quality 90/);
  });

  it("falls back to the classifier and says so, and notes audit.ignore", async () => {
    const root = await project({ "bytecut.config.json": config });
    const { stdout } = await cli(root, ["explain", "public/img/other.jpg"]);
    expect(stdout).toMatch(/\(from classifier, \w+ confidence: /);
    expect(stdout).toMatch(/matched audit\.ignore/);
  });

  it("shows what --preset would do, as JSON", async () => {
    const root = await project();
    const { stdout } = await cli(root, [
      "explain",
      "public/img/small.jpg",
      "--preset",
      "hero",
      "--json",
    ]);
    const [file] = (
      JSON.parse(stdout) as {
        files: Array<{ preset: string; decision: { by: string }; outputs: string[] }>;
      }
    ).files;
    expect(file).toMatchObject({ preset: "hero", decision: { by: "flag" } });
    expect(file!.outputs.length).toBeGreaterThan(0);
  });

  it("is read-only and fails cleanly for a missing file", async () => {
    const root = await project({ "bytecut.config.json": config });
    const before = await listFiles(root);
    await cli(root, ["explain", "public/img/small.jpg"]);
    expect(await listFiles(root)).toEqual(before);
    const failed = await fail(cli(root, ["explain", "nope.jpg"]));
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/No such file: nope\.jpg/);
    expect(failed.stderr).not.toMatch(/at .*\.ts:\d+/);
  });
});

describe("bytecut init", () => {
  it("writes a config with no overrides when everything is at its default", async () => {
    const root = await project();
    const { stdout } = await cli(root, ["init"]);
    expect(stdout).toMatch(/no overrides/);
    expect(JSON.parse(await readFile(join(root, "bytecut.config.json"), "utf8"))).toEqual({});
  });

  it("records only values that differ from detection", async () => {
    const root = await project();
    await cli(root, [
      "init",
      "--out-dir",
      "public/_bytecut", // the default: must not be written
      "--public-path",
      "/img-opt",
      "--placeholder",
      "blurhash",
    ]);
    expect(JSON.parse(await readFile(join(root, "bytecut.config.json"), "utf8"))).toEqual({
      publicPath: "/img-opt",
      manifest: { placeholder: "blurhash" },
    });
  });

  it("and the config it wrote loads and applies", async () => {
    const root = await project();
    await cli(root, ["init", "--out-dir", "public/optimized"]);
    expect((await dryPlan(root)).outDir).toBe("public/optimized");
  });

  it("refuses to overwrite any existing config", async () => {
    const root = await project({ "bytecut.config.toml": 'outDir = "x"\n' });
    const failed = await fail(cli(root, ["init"]));
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/bytecut\.config\.toml already exists/);
    expect(await readFile(join(root, "bytecut.config.toml"), "utf8")).toBe('outDir = "x"\n');
  });

  it("never touches .gitignore, and points out an ignored output folder (§7)", async () => {
    const gitignore = "node_modules\npublic/_bytecut\n";
    const root = await project({ ".gitignore": gitignore });
    const { stderr } = await cli(root, ["init"]);
    expect(stderr).toMatch(/public\/_bytecut is matched by a \.gitignore.*Nothing was changed/);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(gitignore);
    expect((await readdir(root)).sort()).toEqual([".gitignore", "bytecut.config.json", "public"]);
  });

  it("validates its flags", async () => {
    const root = await project();
    expect((await fail(cli(root, ["init", "--placeholder", "sepia"]))).stderr).toMatch(
      /--placeholder must be one of/,
    );
    expect((await fail(cli(root, ["init", "--framework", "rails"]))).stderr).toMatch(
      /--framework must be one of/,
    );
  });
});

describe("bytecut doctor and config errors", () => {
  it("doctor reports the config, an ignored outDir, and a config ffmpeg path", async () => {
    const root = await project({
      ".gitignore": "public/_bytecut/\n",
      "bytecut.config.json": JSON.stringify({ ffmpegPath: "/definitely/not/ffmpeg" }),
    });
    const { stdout } = await cli(root, ["doctor"]);
    expect(stdout).toMatch(/Config:\s+bytecut\.config\.json/);
    expect(stdout).toMatch(/public\/_bytecut is matched by a \.gitignore/);
    const json = JSON.parse((await cli(root, ["doctor", "--json"])).stdout) as {
      ffmpeg: { resolved: { found: boolean; source: string } };
      project: { outDirIgnored: boolean };
    };
    expect(json.ffmpeg.resolved).toMatchObject({ found: false, source: "config" });
    expect(json.project.outDirIgnored).toBe(true);
  });

  it("doctor reports a broken config instead of refusing to diagnose", async () => {
    const root = await project({ "bytecut.config.json": '{ "ouDir": "x" }' });
    const { stdout } = await cli(root, ["doctor"]);
    expect(stdout).toMatch(/problem: .*unknown key "ouDir" \(did you mean "outDir"\?\)/s);
  });

  it("other commands fail with one readable message and no stack", async () => {
    const root = await project({
      "bytecut.config.json":
        '{ "audit": { "rules": { "image/heavvy": "warn" } }, "concurrency": 0 }',
    });
    const failed = await fail(cli(root, ["audit"]));
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/bytecut\.config\.json is not a valid bytecut config:/);
    expect(failed.stderr).toMatch(/unknown rule \(did you mean "image\/heavy"\?\)/);
    expect(failed.stderr).toMatch(/concurrency: /);
    expect(failed.stderr).toMatch(/\[CONFIG_INVALID\]/);
    expect(failed.stderr).not.toMatch(/\n\s+at /);
  });

  it("two config files are an error unless --config chooses", async () => {
    const root = await project({ "bytecut.config.json": "{}", "bytecut.config.toml": "" });
    expect((await fail(cli(root, ["audit"]))).stderr).toMatch(/More than one config file found/);
    await cli(root, ["audit", "--config", "bytecut.config.json", "--no-cache"]);
  });
});

describe("a .ts config under the real bundle (Node's own type stripping)", () => {
  let out: string;
  beforeAll(async () => {
    // The bundle must sit inside the repo so its external dependencies resolve.
    out = join(repoRoot, "test", `.dist-${process.pid}`);
    await execFileAsync(join(repoRoot, "node_modules/.bin/tsup"), ["--out-dir", out], {
      cwd: repoRoot,
    });
  }, 60_000);
  afterAll(() => rm(out, { recursive: true, force: true }));

  const bundle = (cwd: string, args: string[]) =>
    execFileAsync(process.execPath, [join(out, "cli.js"), ...args], { cwd });

  it("loads TypeScript with type annotations and prints no experimental warning", async () => {
    const root = await project({
      "bytecut.config.ts": [
        "import type { Foo } from './types.ts';",
        "interface Cfg { outDir: string }",
        "const config: Cfg = { outDir: 'public/typed' };",
        "export default config;",
      ].join("\n"),
    });
    const { stdout, stderr } = await bundle(root, ["optimize", "--dry-run", "--json"]);
    expect(JSON.parse(stdout).outDir).toBe("public/typed");
    expect(stderr).not.toMatch(/ExperimentalWarning|Type Stripping/i);
  });

  it("explains TypeScript that cannot be stripped", async () => {
    const root = await project({
      "bytecut.config.ts": "enum Dir { A = 'public/a' }\nexport default { outDir: Dir.A };\n",
    });
    const failed = await fail(bundle(root, ["optimize", "--dry-run"]));
    expect(failed.stderr).toMatch(/bytecut\.config\.ts: .*(plain object|could not be loaded)/s);
    expect(failed.stderr).toMatch(/\[CONFIG_INVALID\]/);
  });
});

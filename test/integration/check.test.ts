import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeImageFixtures } from "../../scripts/make-fixtures.js";
import { hashAll, listFiles, tempDir } from "../helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");

let fixtures: string;
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "bytecut-check-fixtures-"));
  await makeImageFixtures(fixtures);
});
afterAll(() => rm(fixtures, { recursive: true, force: true }));

const bytecut = (cwd: string, args: string[]) =>
  execFileAsync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), join(repoRoot, "src/cli/index.ts"), ...args],
    { cwd },
  ).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({
      code: e.code,
      stdout: e.stdout,
      stderr: e.stderr,
    }),
  );

const git = async (cwd: string, ...args: string[]) =>
  (
    await execFileAsync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args])
  ).stdout.trim();

/** A static site with two photos, committed on main. */
async function repo(files: Record<string, string> = {}, sub = ".") {
  const root = await tempDir();
  await git(root, "init", "-q", "-b", "main");
  const site = join(root, sub);
  await mkdir(join(site, "public/img"), { recursive: true });
  for (const name of ["photo.jpg", "small.jpg"]) {
    await cp(join(fixtures, name), join(site, "public/img", name));
  }
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(site, name, ".."), { recursive: true });
    await writeFile(join(site, name), content);
  }
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "base");
  return { root, site };
}

/** A new image, distinct bytes, so it is neither a duplicate nor cached. */
async function addImage(site: string, name: string, width = 500) {
  const data = await sharp(join(fixtures, "photo.jpg"))
    .resize(width)
    .jpeg({ quality: 70 })
    .toBuffer();
  await writeFile(join(site, "public/img", name), data);
}

/** Distinct files the findings are about. */
const filesOf = (report: { findings: Array<{ source?: string }> }) =>
  [...new Set(report.findings.map((f) => f.source).filter((x): x is string => !!x))].sort();

const OVER_BUDGET = JSON.stringify({ budgets: { maxFileSize: "1 B" } });
const json = (stdout: string) =>
  JSON.parse(stdout) as {
    ok: boolean;
    counts: { error: number; warn: number };
    changed: { base: string; changedFiles: number; everything: boolean } | null;
    findings: Array<{ ruleId: string; source?: string; severity: string }>;
  };

describe("bytecut check", () => {
  it("passes on a clean zero-config project: no rule is an error by default", async () => {
    const { site } = await repo();
    const r = await bytecut(site, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Scanned 2 images/);
    expect(r.stderr).toMatch(/bytecut check: passed/);
  });

  it("fails with exit 1 when a rule is an error, and says how many", async () => {
    const { site } = await repo({ "bytecut.config.json": OVER_BUDGET });
    const r = await bytecut(site, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("project/over-budget");
    expect(r.stderr).toMatch(/bytecut check: failed \(2 failing findings/);
  });

  it("a config can promote a rule to error, which then fails the check", async () => {
    const { site } = await repo({
      "bytecut.config.json": JSON.stringify({
        audit: { rules: { "image/no-modern-format": "error" } },
      }),
    });
    expect((await bytecut(site, ["check"])).code).toBe(1);
  });

  it("--fail-on warn fails on warnings that the default tolerates", async () => {
    const { site } = await repo();
    expect((await bytecut(site, ["check"])).code).toBe(0);
    const strict = await bytecut(site, ["check", "--fail-on", "warn", "--report", "json"]);
    expect(strict.code).toBe(1);
    expect(json(strict.stdout)).toMatchObject({ ok: false });
  });

  it("writes nothing: not a cache, not a manifest, and the repo stays clean", async () => {
    const { root, site } = await repo({ "bytecut.config.json": OVER_BUDGET });
    const before = (await listFiles(root)).filter((f) => !f.startsWith(".git/"));
    await bytecut(site, ["check"]);
    await bytecut(site, ["check", "--report", "md"]);
    await bytecut(site, ["check", "--changed"]);
    expect((await listFiles(root)).filter((f) => !f.startsWith(".git/"))).toEqual(before);
    expect(await git(root, "status", "--porcelain")).toBe("");
  });

  it("leaves sources untouched", async () => {
    const { site } = await repo({ "bytecut.config.json": OVER_BUDGET });
    const names = ["photo.jpg", "small.jpg"];
    const before = await hashAll(join(site, "public/img"), names);
    await bytecut(site, ["check"]);
    expect(await hashAll(join(site, "public/img"), names)).toEqual(before);
  });
});

describe("check reports", () => {
  it("--report json prints only JSON on stdout and keeps the verdict on stderr", async () => {
    const { site } = await repo({ "bytecut.config.json": OVER_BUDGET });
    const r = await bytecut(site, ["check", "--report", "json"]);
    expect(r.code).toBe(1);
    const report = json(r.stdout);
    expect(report.ok).toBe(false);
    expect(report.counts.error).toBe(2);
    expect(report.findings.filter((f) => f.severity === "error").map((f) => f.ruleId)).toEqual([
      "project/over-budget",
      "project/over-budget",
    ]);
    expect(r.stderr).toMatch(/failed/);
  });

  it("--report md prints the PR comment and nothing else on stdout", async () => {
    const { site } = await repo({ "bytecut.config.json": OVER_BUDGET });
    const r = await bytecut(site, ["check", "--report", "md"]);
    expect(r.stdout.startsWith("## bytecut check: failed\n")).toBe(true);
    expect(r.stdout).toContain("### `project/over-budget` · error · 2 files");
    expect(r.stdout).toContain("| public/img/photo.jpg |");
    expect(r.code).toBe(1);
  });
});

describe("check --changed", () => {
  it("with no changes passes even though unchanged files are over budget", async () => {
    const { site } = await repo({ "bytecut.config.json": OVER_BUDGET });
    expect((await bytecut(site, ["check"])).code).toBe(1);
    const r = await bytecut(site, ["check", "--changed", "--report", "json"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({
      ok: true,
      changed: { base: "HEAD", changedFiles: 0, everything: false },
      findings: [],
    });
  });

  it("an untracked new image is checked, and only it", async () => {
    const { root, site } = await repo({ "bytecut.config.json": OVER_BUDGET });
    await addImage(site, "new.jpg");
    const r = await bytecut(site, ["check", "--changed", "--report", "json"]);
    expect(r.code).toBe(1);
    expect(filesOf(json(r.stdout))).toEqual(["public/img/new.jpg"]);
    expect(await git(root, "status", "--porcelain")).toBe("?? public/img/new.jpg");
  });

  it("a modified tracked file and a staged one count", async () => {
    const { root, site } = await repo({ "bytecut.config.json": OVER_BUDGET });
    await addImage(site, "small.jpg", 200); // tracked, now different
    await addImage(site, "staged.jpg", 300);
    await git(root, "add", "public/img/staged.jpg");
    const report = json((await bytecut(site, ["check", "--changed", "--report", "json"])).stdout);
    expect(filesOf(report)).toEqual(["public/img/small.jpg", "public/img/staged.jpg"]);
  });

  it("compares against a base ref: commits since the merge-base are in scope", async () => {
    const { root, site } = await repo({ "bytecut.config.json": OVER_BUDGET });
    await git(root, "checkout", "-q", "-b", "feature");
    await addImage(site, "feature.jpg");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "feature");

    const vsMain = json(
      (await bytecut(site, ["check", "--changed", "main", "--report", "json"])).stdout,
    );
    expect(vsMain.changed).toMatchObject({ base: "main", changedFiles: 1 });
    expect(filesOf(vsMain)).toEqual(["public/img/feature.jpg"]);

    // Against HEAD the working tree is clean, so nothing is in scope.
    const vsHead = json((await bytecut(site, ["check", "--changed", "--report", "json"])).stdout);
    expect(vsHead.findings).toEqual([]);
  });

  it("measures from the merge-base, so work that landed on the base branch is not 'changed'", async () => {
    const { root, site } = await repo({ "bytecut.config.json": OVER_BUDGET });
    await git(root, "checkout", "-q", "-b", "feature");
    await addImage(site, "feature.jpg");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "feature");
    // Meanwhile main moves on, changing a different image.
    await git(root, "checkout", "-q", "main");
    await addImage(site, "small.jpg", 250);
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "main moved");
    await git(root, "checkout", "-q", "feature");

    const r = await bytecut(site, ["check", "--changed", "main", "--report", "json"]);
    expect(filesOf(json(r.stdout))).toEqual(["public/img/feature.jpg"]);
  });

  it("project-level findings (no file) still count under --changed", async () => {
    const { site } = await repo({
      "bytecut.config.json": JSON.stringify({ budgets: { maxTotalSize: "1 B" } }),
    });
    const r = await bytecut(site, ["check", "--changed", "--report", "json"]);
    expect(r.code).toBe(1);
    expect(json(r.stdout).findings).toEqual([
      expect.objectContaining({ ruleId: "project/over-budget", severity: "error" }),
    ]);
  });

  it("a changed config puts every file in scope", async () => {
    const { root, site } = await repo({ "bytecut.config.json": "{}" });
    await writeFile(join(site, "bytecut.config.json"), OVER_BUDGET);
    const r = await bytecut(site, ["check", "--changed", "--report", "json"]);
    expect(r.code).toBe(1);
    const report = json(r.stdout);
    expect(report.changed?.everything).toBe(true);
    // Both photos are now in scope, not just the file whose bytes changed (none did).
    expect(filesOf(report)).toEqual(["public/img/photo.jpg", "public/img/small.jpg"]);
    expect(await git(root, "status", "--porcelain")).toBe("M bytecut.config.json");
  });

  it("takes paths after --changed=<base>, and works from a subfolder of the repository", async () => {
    const { site } = await repo({ "bytecut.config.json": OVER_BUDGET }, "site");
    await addImage(site, "new.jpg");
    const r = await bytecut(site, ["check", "--changed=HEAD", "public", "--report", "json"]);
    expect(filesOf(json(r.stdout))).toEqual(["public/img/new.jpg"]);
  });

  it("a deleted file is not reported", async () => {
    const { root, site } = await repo({ "bytecut.config.json": OVER_BUDGET });
    await rm(join(site, "public/img/small.jpg"));
    const r = await bytecut(site, ["check", "--changed", "--report", "json"]);
    expect(r.code).toBe(0);
    expect(await git(root, "status", "--porcelain")).toBe("D public/img/small.jpg");
  });
});

describe("check could not run: exit 2", () => {
  it("outside a git repository", async () => {
    const root = await tempDir();
    await mkdir(join(root, "public"), { recursive: true });
    await cp(join(fixtures, "small.jpg"), join(root, "public/small.jpg"));
    const r = await bytecut(root, ["check", "--changed"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/not inside one.*\[GIT_UNAVAILABLE\]/);
    // Without --changed the same project checks fine.
    expect((await bytecut(root, ["check"])).code).toBe(0);
  });

  it("with a ref that does not exist, and with an option-looking ref", async () => {
    const { site } = await repo();
    const missing = await bytecut(site, ["check", "--changed=origin/nope"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/ref "origin\/nope" is not in this repository/);
    const option = await bytecut(site, ["check", "--changed=--output=/tmp/x"]);
    expect(option.code).toBe(2);
    expect(option.stderr).toMatch(/not a git ref/);
  });

  it("in a shallow clone that lacks the base, with the fix named", async () => {
    const { root, site } = await repo();
    await addImage(site, "second.jpg");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "second");
    await addImage(site, "third.jpg", 450);
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "third");

    const clone = await tempDir();
    await execFileAsync("git", ["clone", "-q", "--depth", "1", `file://${root}`, clone]);
    const r = await bytecut(clone, ["check", "--changed=HEAD~2"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/shallow clone.*fetch-depth: 0/);
  });

  it("with bad flag values or a broken config", async () => {
    const { site } = await repo();
    expect((await bytecut(site, ["check", "--report", "html"])).code).toBe(2);
    expect((await bytecut(site, ["check", "--fail-on", "info"])).code).toBe(2);

    await writeFile(join(site, "bytecut.config.json"), '{ "ouDir": "x" }');
    const broken = await bytecut(site, ["check"]);
    expect(broken.code).toBe(2);
    expect(broken.stderr).toMatch(/\[CONFIG_INVALID\]/);
  });
});

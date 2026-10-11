import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeImageFixtures } from "../../scripts/make-fixtures.js";
import { hashAll, tempDir } from "../helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const tsx = ["--import", import.meta.resolve("tsx"), join(repoRoot, "src/cli/index.ts")];

let fixtures: string;
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "bytecut-compare-fixtures-"));
  await makeImageFixtures(fixtures);
});
afterAll(() => rm(fixtures, { recursive: true, force: true }));

async function optimized() {
  const root = await tempDir();
  await mkdir(join(root, "public/img"), { recursive: true });
  await cp(join(fixtures, "photo.jpg"), join(root, "public/img/photo.jpg"));
  await writeFile(
    join(root, "bytecut.config.json"),
    JSON.stringify({ presets: { photo: { widths: [480], formats: ["webp"] } } }),
  );
  await execFileAsync(process.execPath, [...tsx, "optimize", "-y"], { cwd: root });
  return root;
}

function startCompare(cwd: string, args: string[]) {
  const child = spawn(process.execPath, [...tsx, "compare", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = new Promise<string>((resolve, reject) => {
    let out = "";
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
      const m = /(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/)/.exec(out);
      if (m) resolve(m[1]!);
    });
    child.on("close", (code) => reject(new Error(`exited ${code} before listening: ${out}`)));
  });
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return { child, url, exited };
}

describe("bytecut compare", () => {
  it("serves the page and the files, then stops cleanly on Ctrl-C", async () => {
    const root = await optimized();
    const before = await hashAll(join(root, "public/img"), ["photo.jpg"]);
    const { child, url, exited } = startCompare(root, ["public/img/photo.jpg"]);
    try {
      const base = await url;
      const page = await fetch(base);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("bytecut compare");

      const data = (await (await fetch(`${base}data.json`)).json()) as {
        outputs: Array<{ index: number; path: string; bytes: number }>;
      };
      expect(data.outputs.map((o) => o.path)).toEqual(["img/photo/photo-480.webp"]);

      const output = Buffer.from(await (await fetch(`${base}file/0`)).arrayBuffer());
      expect(output.byteLength).toBe(data.outputs[0]!.bytes);
      expect(output.subarray(0, 4).toString()).toBe("RIFF");
      const original = Buffer.from(await (await fetch(`${base}file/original`)).arrayBuffer());
      expect(original.equals(await readFile(join(root, "public/img/photo.jpg")))).toBe(true);

      // No page without the token.
      expect((await fetch(new URL("/", base))).status).toBe(404);
    } finally {
      child.kill("SIGINT");
    }
    expect(await exited).toBe(0);
    expect(await hashAll(join(root, "public/img"), ["photo.jpg"])).toEqual(before);
  }, 60_000);

  it("fails with a fix when the file has not been optimized", async () => {
    const root = await optimized();
    await cp(join(fixtures, "photo.jpg"), join(root, "public/img/other.jpg"));
    const { child, url, exited } = startCompare(root, ["public/img/other.jpg"]);
    await expect(url).rejects.toThrow(/has not been optimized yet/);
    expect(await exited).toBe(1);
    child.kill();
  }, 60_000);

  it("needs exactly one file", async () => {
    const root = await optimized();
    const { url } = startCompare(root, []);
    await expect(url).rejects.toThrow(/Name one optimized file/);
  }, 60_000);
});

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSnippet } from "../../src/core/snippets/build.js";
import { heroEntry, manifestWith, photoEntry, videoEntry } from "../snippets-fixtures.js";

const execFileAsync = promisify(execFile);
const repo = resolve(import.meta.dirname, "../..");
// Inside the repo so `react` and `@types/react` resolve from its node_modules.
const dir = join(repo, `test/.jsx-check-${process.pid}`);
const tsc = join(repo, "node_modules/typescript/bin/tsc");

beforeAll(async () => {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        types: [],
        skipLibCheck: true,
      },
      include: ["*.tsx"],
    }),
  );
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function typecheck(name: string, body: string): Promise<{ ok: boolean; output: string }> {
  await writeFile(
    join(dir, `${name}.tsx`),
    `export function Component() {\n  return (\n    <>\n${body}\n    </>\n  );\n}\n`,
  );
  try {
    const { stdout } = await execFileAsync(process.execPath, [tsc, "-p", dir], { cwd: repo });
    return { ok: true, output: stdout };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const manifest = manifestWith(
  { "public/img/photo.jpg": photoEntry(), "public/img/hero.jpg": heroEntry() },
  {
    "public/v/background.mp4": videoEntry("background-video"),
    "public/v/clip.mp4": videoEntry("content-video", true),
    "public/v/spinner.gif": videoEntry("gif-to-video"),
  },
);

const snippet = (source: string, options: Record<string, unknown> = {}) =>
  buildSnippet(
    manifest,
    { source, originalUrl: `/${source.replace(/^public\//, "")}` },
    { format: "jsx", ...options },
  )!.code;

const indent = (code: string) =>
  code
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");

describe("generated JSX type-checks against @types/react (§M6 acceptance)", () => {
  it("every snippet kind compiles in a sample React component", async () => {
    const body = [
      snippet("public/img/photo.jpg"),
      snippet("public/img/photo.jpg", { alt: "A purple field", className: "card", sizes: "50vw" }),
      snippet("public/img/hero.jpg", { alt: "Skyline" }),
      snippet("public/v/background.mp4"),
      snippet("public/v/clip.mp4"),
      snippet("public/v/spinner.gif", { className: "spinner" }),
    ]
      .map(indent)
      .join("\n");
    const result = await typecheck("all", body);
    expect(result.output, result.output).toBe("");
    expect(result.ok).toBe(true);
  }, 60_000);

  it("compiles with every placeholder style, and an alt text that needs escaping", async () => {
    const variants = [
      photoEntry({ placeholder: { kind: "lqip", value: "data:image/webp;base64,UklGRg==" } }),
      photoEntry({ placeholder: { kind: "blurhash", value: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" } }),
      photoEntry({ placeholder: undefined }),
    ];
    const bodies = variants.map((entry, i) => {
      const m = manifestWith({ [`public/img/p${i}.jpg`]: entry });
      return buildSnippet(
        m,
        { source: `public/img/p${i}.jpg`, originalUrl: `/img/p${i}.jpg` },
        { format: "jsx", alt: `Tom & "Jerry" {x} é` },
      )!.code;
    });
    const result = await typecheck("variants", bodies.map(indent).join("\n"));
    expect(result.output, result.output).toBe("");
    expect(result.ok).toBe(true);
  }, 60_000);

  describe("negative controls: the check can fail", () => {
    it("rejects the HTML spelling `class`", async () => {
      const result = await typecheck("neg-class", '      <img src="/a.jpg" class="x" alt="" />');
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/class/);
    });

    it("rejects lowercase `fetchpriority` and `srcset`", async () => {
      const result = await typecheck(
        "neg-attrs",
        '      <img src="/a.jpg" fetchpriority="high" srcset="a 1w" alt="" />',
      );
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/fetchpriority|srcset/);
    });

    it("rejects an HTML string style attribute", async () => {
      const result = await typecheck(
        "neg-style",
        '      <img src="/a.jpg" alt="" style="background-color:#fff" />',
      );
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/style/);
    });

    it("rejects the HTML spelling of video attributes", async () => {
      const result = await typecheck("neg-video", "      <video autoplay playsinline></video>");
      expect(result.ok).toBe(false);
    });
  });
});

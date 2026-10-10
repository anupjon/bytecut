import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type Framework = "next" | "astro" | "vite" | "static";

export interface ProjectInfo {
  framework: Framework;
  /** `react` is a dependency, which decides JSX vs HTML for snippets under Vite. */
  react: boolean;
  /** POSIX paths relative to the project root that are scanned when no paths are given. */
  include: string[];
  /** Default output folder, relative to the project root. */
  outDir: string;
  publicPath: string;
  /**
   * The folder whose contents are served at the site root. Output paths mirror the source
   * relative to this, so `public/img/a.jpg` → `<outDir>/img/a/…` is served at `/_bytecut/img/a/…`.
   * `"."` means the project root.
   */
  staticRoot: string;
}

const FRAMEWORK_CONFIG: Array<[Framework, RegExp]> = [
  ["next", /^next\.config\.(js|mjs|cjs|ts)$/],
  ["astro", /^astro\.config\.(js|mjs|cjs|ts)$/],
  ["vite", /^vite\.config\.(js|mjs|cjs|ts|mts|cts)$/],
];
const FRAMEWORK_DEP: Array<[Framework, string]> = [
  ["next", "next"],
  ["astro", "astro"],
  ["vite", "vite"],
];

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

async function readDependencies(root: string): Promise<Set<string>> {
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const names = new Set<string>();
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const section = pkg[key];
      if (section && typeof section === "object") {
        for (const name of Object.keys(section)) names.add(name);
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Order matters: Astro and Next both pull in Vite-like tooling, so the more specific
 * framework wins over `vite`.
 */
export async function detectProject(root: string): Promise<ProjectInfo> {
  const deps = await readDependencies(root);
  const files = await readdir(root).catch(() => [] as string[]);

  let framework: Framework = "static";
  for (const [candidate, dep] of FRAMEWORK_DEP) {
    const byConfig = FRAMEWORK_CONFIG.some(
      ([name, re]) => name === candidate && files.some((f) => re.test(f)),
    );
    if (deps.has(dep) || byConfig) {
      framework = candidate;
      break;
    }
  }

  const react = deps.has("react");
  const hasPublic = await isDirectory(join(root, "public"));
  if (framework !== "static" || hasPublic) {
    return {
      framework,
      react,
      include: ["public"],
      outDir: "public/_bytecut",
      publicPath: "/_bytecut",
      staticRoot: "public",
    };
  }
  return {
    framework,
    react,
    include: ["."],
    outDir: "_bytecut",
    publicPath: "/_bytecut",
    staticRoot: ".",
  };
}

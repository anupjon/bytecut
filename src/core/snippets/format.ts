import type { Framework } from "../scan/detect.js";
import type { Syntax } from "./render.js";

/** The URL an original is served at: its path relative to the static root. */
export function originalUrl(source: string, staticRoot: string): string {
  const rel =
    staticRoot === "." || staticRoot === ""
      ? source
      : source.startsWith(`${staticRoot}/`)
        ? source.slice(staticRoot.length + 1)
        : source;
  return `/${rel}`;
}

/**
 * JSX for React-based projects (Next.js, or Vite with React), HTML otherwise. Astro templates
 * are HTML-syntax, so they get HTML (`class`, lowercase attributes), not JSX.
 */
export function snippetFormatFor(project: { framework: Framework; react?: boolean }): Syntax {
  switch (project.framework) {
    case "next":
      return "jsx";
    case "vite":
      return project.react ? "jsx" : "html";
    case "astro":
    case "static":
      return "html";
  }
}

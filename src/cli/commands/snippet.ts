import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { defineCommand } from "citty";
import { BytecutError } from "../../core/errors.js";
import { parseManifest } from "../../core/manifest/io.js";
import { MANIFEST_FILE } from "../../core/manifest/types.js";
import { toPosix } from "../../core/posix.js";
import {
  buildSnippet,
  originalUrl,
  snippetFormatFor,
  type Syntax,
} from "../../core/snippets/index.js";
import { guarded } from "../errors.js";
import { discover } from "../shared.js";

export default defineCommand({
  meta: {
    name: "snippet",
    description: "Print the <picture> / <video> markup for files that have been optimized",
  },
  args: {
    format: { type: "string", description: "html or jsx (default: from the detected framework)" },
    alt: { type: "string", description: "Alt text for images (default: empty, i.e. decorative)" },
    sizes: { type: "string", description: 'The sizes attribute (default: "100vw")' },
    class: { type: "string", description: "A class (className in JSX) to add to the element" },
    priority: {
      type: "boolean",
      description: 'Mark as the main image: fetchpriority="high", no lazy loading',
    },
    lazy: { type: "boolean", description: "Lazy-load even a priority image" },
    "out-dir": { type: "string", description: "Output folder (default: from the framework)" },
    json: { type: "boolean", description: "Print structured data instead of markup" },
  },
  run: guarded(async ({ args }) => {
    const inputs = args._.map(String);
    if (inputs.length === 0) {
      throw new BytecutError(
        "BAD_ARGUMENTS",
        "Name at least one optimized file, e.g. `bytecut snippet public/img/hero.jpg`.",
      );
    }
    const found = await discover([], args["out-dir"]);
    const format = (args.format as string | undefined) ?? snippetFormatFor(found.project);
    if (format !== "html" && format !== "jsx") {
      throw new BytecutError("BAD_ARGUMENTS", `--format must be html or jsx, not "${format}".`);
    }

    let manifestText: string;
    try {
      manifestText = await readFile(
        resolve(found.projectRoot, found.outDir, MANIFEST_FILE),
        "utf8",
      );
    } catch {
      throw new BytecutError(
        "INPUT_NOT_FOUND",
        `No manifest at ${found.outDir}/${MANIFEST_FILE}. Run \`bytecut optimize -y\` first.`,
      );
    }
    const manifest = parseManifest(manifestText);

    const results = [];
    for (const input of inputs) {
      const source = toPosix(relative(found.projectRoot, resolve(found.projectRoot, input)));
      const snippet = buildSnippet(
        manifest,
        { source, originalUrl: originalUrl(source, found.project.staticRoot) },
        {
          format: format as Syntax,
          ...(args.alt !== undefined ? { alt: String(args.alt) } : {}),
          ...(args.sizes ? { sizes: String(args.sizes) } : {}),
          ...(args.class ? { className: String(args.class) } : {}),
          ...(args.priority ? { priority: true } : {}),
          ...(args.lazy ? { lazy: true } : {}),
        },
      );
      if (!snippet) {
        throw new BytecutError(
          "INPUT_NOT_FOUND",
          `${source} has not been optimized yet. Run \`bytecut optimize -y ${input}\` first.`,
        );
      }
      results.push(snippet);
    }

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ version: 1, format, snippets: results }, null, 2)}\n`,
      );
      return;
    }
    // Markup only on stdout so it pipes into a file or the clipboard; advice goes to stderr.
    console.log(results.map((s) => s.code).join("\n\n"));
    for (const s of results)
      for (const hint of s.hints) console.error(`Note (${s.source}): ${hint}`);
  }),
});

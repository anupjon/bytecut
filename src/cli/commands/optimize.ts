import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import pkg from "../../../package.json" with { type: "json" };
import { optimize } from "../../core/commands/optimize.js";
import { detectProject } from "../../core/scan/detect.js";
import { sharpImageEngine } from "../../core/engines/image.js";
import { BytecutError } from "../../core/errors.js";
import { parsePlan, serializePlan } from "../../core/plan/schema.js";
import type { Plan } from "../../core/plan/types.js";
import { guarded } from "../errors.js";
import { formatFindings, formatPlan, formatSummary } from "../format.js";

const FRAMEWORK_NAMES: Record<string, string> = {
  next: "Next.js",
  astro: "Astro",
  vite: "Vite",
  static: "a static site",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default defineCommand({
  meta: {
    name: "optimize",
    description: "Optimize images into the output folder (sources are never modified)",
  },
  args: {
    yes: {
      type: "boolean",
      alias: "y",
      description: "Write outputs; without it only the plan is printed",
    },
    "dry-run": { type: "boolean", description: "Print the plan and write nothing" },
    json: { type: "boolean", description: "With --dry-run: print the plan as JSON on stdout" },
    plan: { type: "string", description: "Execute a plan saved with --dry-run --json" },
    force: {
      type: "boolean",
      description: "Re-encode unchanged files and overwrite outputs bytecut does not own",
    },
    "out-dir": {
      type: "string",
      description: "Output folder (default: from the detected framework)",
    },
    "public-path": { type: "string", description: "URL prefix for outputs (default: /_bytecut)" },
    preset: {
      type: "string",
      description: "Force a preset (photo, hero, icon) instead of classifying",
    },
  },
  run: guarded(async ({ args }) => {
    const inputs = args._.map(String);
    const planFile = args.plan;
    const dryRun = Boolean(args["dry-run"]) || !args.yes;

    if (planFile && (inputs.length > 0 || args["out-dir"] || args["public-path"])) {
      throw new BytecutError(
        "BAD_ARGUMENTS",
        "--plan already fixes the sources, output folder and public path; don't combine it with paths, --out-dir or --public-path.",
      );
    }
    if (planFile && args.preset) {
      throw new BytecutError("BAD_ARGUMENTS", "--plan already fixes each file's preset.");
    }
    if (args.json && !dryRun) {
      throw new BytecutError(
        "BAD_ARGUMENTS",
        "--json is only supported with --dry-run for now (stdout would mix two formats).",
      );
    }

    let savedPlan: Plan | undefined;
    if (planFile) {
      const text = await readFile(resolve(planFile), "utf8").catch(() => {
        throw new BytecutError("INPUT_NOT_FOUND", `Cannot read plan file: ${planFile}`);
      });
      savedPlan = parsePlan(text, planFile);
    }

    const controller = new AbortController();
    const onSigint = () => controller.abort();
    if (!dryRun) process.once("SIGINT", onSigint);

    const projectRoot = process.cwd();
    const project = await detectProject(projectRoot);

    // Zero-config: with no paths, scan the framework's asset folders.
    let scanInputs = inputs;
    if (!savedPlan && inputs.length === 0) {
      scanInputs = project.include.filter((p) => existsSync(resolve(projectRoot, p)));
      if (scanInputs.length === 0) {
        console.error(
          `bytecut optimize: no asset folder found (looked for ${project.include.join(", ")}). Pass files or folders.`,
        );
        process.exitCode = 2;
        return;
      }
      console.error(
        `Detected ${FRAMEWORK_NAMES[project.framework]}: scanning ${scanInputs.join(", ")} → ${args["out-dir"] ?? project.outDir}`,
      );
    }

    const outcome = await optimize({
      projectRoot,
      engine: sharpImageEngine,
      toolVersion: pkg.version,
      ...(savedPlan ? { savedPlan } : { inputs: scanInputs }),
      outDir: savedPlan?.outDir ?? args["out-dir"] ?? project.outDir,
      staticRoot: project.staticRoot,
      publicPath: args["public-path"] ?? project.publicPath,
      ...(args.preset ? { presetOverride: args.preset } : {}),
      execute: !dryRun,
      force: Boolean(args.force),
      concurrency: Math.min(4, availableParallelism()),
      signal: controller.signal,
      onItemDone: (item, done, total) => console.error(`[${done}/${total}] ${item.source}`),
    });
    process.off("SIGINT", onSigint);

    for (const file of outcome.unsupported) {
      console.warn(`Skipping ${file}: not a supported image (JPEG, PNG, WebP, AVIF).`);
    }
    if (outcome.svgs.length > 0) {
      console.warn(
        `Skipping ${plural(outcome.svgs.length, "SVG file")}: SVG output is not implemented yet (see \`bytecut audit\`).`,
      );
    }
    if (outcome.videos.length > 0) {
      console.warn(
        `Skipping ${plural(outcome.videos.length, "video file")}: video support arrives in a later release.`,
      );
    }
    if (outcome.plan.items.length === 0) {
      console.log("No images found.");
      return;
    }

    const findings = formatFindings(outcome.findings);

    if (dryRun) {
      if (args.json) {
        // stdout carries only the plan so it can be piped to a file and passed to --plan.
        process.stdout.write(serializePlan(outcome.plan));
        if (findings) console.error(findings);
        return;
      }
      console.log(formatPlan(outcome.plan, outcome.cache));
      if (findings) console.log(`\n${findings}`);
      console.log("\nDry run: nothing written. Re-run with -y to write these outputs.");
      return;
    }

    const result = outcome.result!;
    console.log(formatSummary(result));
    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
    if (findings) console.log(`\n${findings}`);

    if (result.cancelled) process.exitCode = 130;
    else if (result.items.some((i) => i.status === "failed")) process.exitCode = 1;
  }),
});

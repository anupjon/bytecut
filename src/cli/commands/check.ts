import { defineCommand } from "citty";
import { audit } from "../../core/commands/audit.js";
import { evaluate, type FailOn } from "../../core/commands/check.js";
import { sharpImageEngine } from "../../core/engines/image.js";
import { svgoEngine } from "../../core/engines/svg.js";
import { BytecutError } from "../../core/errors.js";
import { changedFiles } from "../../core/git/changed.js";
import { renderJsonReport } from "../../core/report/json.js";
import { renderMarkdownReport } from "../../core/report/markdown.js";
import { plural } from "../../core/units.js";
import { formatAuditReport } from "../format.js";
import {
  configArg,
  createVideoEngine,
  discover,
  ffmpegInstallText,
  ffmpegStatus,
  noAssetsMessage,
} from "../shared.js";
import { run } from "../system.js";

/**
 * Exit codes: 0 passed, 1 the project has failing findings, 2 the check could not run (bad
 * flags, broken config, no git, nothing to scan). CI can then tell "fix your images" from
 * "fix your pipeline". Everything that stops the check before a verdict maps to 2.
 */
export const EXIT = { ok: 0, failed: 1, unusable: 2 } as const;

const REPORTS = ["md", "json"] as const;
const FAIL_ON: FailOn[] = ["error", "warn"];

export default defineCommand({
  meta: {
    name: "check",
    description: "CI mode: audit the project and exit non-zero if any finding is an error",
  },
  args: {
    ...configArg,
    // Declared boolean so a bare `--changed` never swallows the flag after it; the base ref
    // is read from the raw arguments below.
    changed: {
      type: "boolean",
      description:
        "Only report files changed since a git ref: --changed (HEAD, i.e. local changes), --changed origin/main or --changed=origin/main",
    },
    report: { type: "string", description: "Print a report on stdout: md or json" },
    "fail-on": {
      type: "string",
      description: "Lowest severity that fails the check: error (default) or warn",
    },
    all: { type: "boolean", description: "Text report: every finding, not the first 10 per rule" },
    "out-dir": {
      type: "string",
      description: "Output folder (default: from the detected framework)",
    },
    ffmpeg: { type: "string", description: "Path to the ffmpeg binary" },
    ffprobe: { type: "string", description: "Path to the ffprobe binary" },
  },
  run: async ({ args, rawArgs }) => {
    try {
      process.exitCode = await check(args, rawArgs);
    } catch (error) {
      if (!(error instanceof BytecutError)) throw error;
      console.error(`bytecut: ${error.message} [${error.code}]`);
      process.exitCode = EXIT.unusable;
    }
  },
});

async function check(
  args: Record<string, unknown> & { _: string[] },
  rawArgs: string[],
): Promise<number> {
  const report = args.report as string | undefined;
  if (report !== undefined && !(REPORTS as readonly string[]).includes(report)) {
    throw new BytecutError("BAD_ARGUMENTS", `--report must be md or json, not "${report}".`);
  }
  const failOn = (args["fail-on"] as string | undefined) ?? "error";
  if (!FAIL_ON.includes(failOn as FailOn)) {
    throw new BytecutError("BAD_ARGUMENTS", `--fail-on must be error or warn, not "${failOn}".`);
  }

  // `--changed` alone means HEAD; `--changed <ref>` and `--changed=<ref>` name the base. A
  // path must therefore come before `--changed` (or the ref be written with `=`).
  let changedBase: string | null = null;
  const positional = (args._ as string[]).map(String);
  const at = rawArgs.findIndex((a) => a === "--changed" || a.startsWith("--changed="));
  if (at !== -1) {
    const arg = rawArgs[at]!;
    const next = rawArgs[at + 1];
    if (arg.includes("=")) changedBase = arg.slice(arg.indexOf("=") + 1) || "HEAD";
    else if (next !== undefined && !next.startsWith("-")) {
      changedBase = next;
      const i = positional.indexOf(next);
      if (i !== -1) positional.splice(i, 1);
    } else changedBase = "HEAD";
  }

  const found = await discover(
    positional,
    args["out-dir"] as string | undefined,
    args.config as string | undefined,
  );
  if (found.scanInputs.length === 0) {
    console.error(noAssetsMessage("check", found.project));
    return EXIT.unusable;
  }
  const { config } = found;

  const changed =
    changedBase === null
      ? null
      : await changedFiles({ projectRoot: found.projectRoot, base: changedBase, run });

  // Nothing is written: no analysis cache, and a check must leave the repository as it found it.
  const result = await audit({
    projectRoot: found.projectRoot,
    engine: sharpImageEngine,
    svgEngine: svgoEngine,
    inputs: found.scanInputs,
    outDir: found.outDir,
    staticRoot: found.project.staticRoot,
    ffmpeg: ffmpegStatus(config),
    videoEngine: createVideoEngine(
      { ffmpeg: args.ffmpeg as string | undefined, ffprobe: args.ffprobe as string | undefined },
      config,
    ),
    needsFfmpeg: ffmpegInstallText(),
    persistCache: false,
    policy: config.policy,
    exclude: config.exclude,
    ignore: config.auditIgnore,
    settings: config.rules,
    budgets: config.budgets,
  });

  const verdict = evaluate(result, { failOn: failOn as FailOn, changed });

  if (report === "json") process.stdout.write(renderJsonReport(result, verdict));
  else if (report === "md") process.stdout.write(renderMarkdownReport(result, verdict));
  else {
    const view = { ...result, findings: verdict.findings };
    console.log(formatAuditReport(view, { all: Boolean(args.all) }));
    if (verdict.scope) {
      console.log(
        verdict.scope.everything
          ? `A bytecut config changed since ${verdict.scope.base}: every file is in scope.`
          : `${plural(verdict.scope.changedFiles, "file")} changed since ${verdict.scope.base}; findings about other files are not shown (${verdict.scope.dropped} hidden).`,
      );
    }
  }

  const summary = `${plural(verdict.counts.error, "error")}, ${plural(verdict.counts.warn, "warning")}`;
  console.error(
    verdict.ok
      ? `bytecut check: passed (${summary}).`
      : `bytecut check: failed (${plural(verdict.failing.length, "failing finding")}; ${summary}).`,
  );
  return verdict.ok ? EXIT.ok : EXIT.failed;
}

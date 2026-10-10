import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { audit } from "../../core/commands/audit.js";
import { sharpImageEngine } from "../../core/engines/image.js";
import { svgoEngine } from "../../core/engines/svg.js";
import { installHint, resolveBinary } from "../../core/ffmpeg/index.js";
import { detectProject } from "../../core/scan/detect.js";
import { guarded } from "../errors.js";
import { formatAuditReport } from "../format.js";
import { isFile, readOsReleaseId } from "../system.js";

export default defineCommand({
  meta: {
    name: "audit",
    description: "Report what is too heavy in your image assets, with estimated savings",
  },
  args: {
    json: { type: "boolean", description: "Print the report as JSON" },
    all: { type: "boolean", description: "Show every finding instead of the first 10 per rule" },
    "out-dir": {
      type: "string",
      description: "Output folder (default: from the detected framework)",
    },
    cache: {
      type: "boolean",
      default: true,
      description:
        "Keep the analysis cache in <outDir>/.bytecut-cache (--no-cache to avoid writing)",
    },
  },
  run: guarded(async ({ args }) => {
    const projectRoot = process.cwd();
    const project = await detectProject(projectRoot);
    const inputs = args._.map(String);
    const scanInputs =
      inputs.length > 0
        ? inputs
        : project.include.filter((p) => existsSync(resolve(projectRoot, p)));
    if (scanInputs.length === 0) {
      console.error(
        `bytecut audit: no asset folder found (looked for ${project.include.join(", ")}). Pass files or folders.`,
      );
      process.exitCode = 2;
      return;
    }

    const ffmpeg = resolveBinary(
      "ffmpeg",
      { env: process.env, platform: process.platform },
      { isFile },
    );
    const report = await audit({
      projectRoot,
      engine: sharpImageEngine,
      svgEngine: svgoEngine,
      inputs: scanInputs,
      outDir: args["out-dir"] ?? project.outDir,
      staticRoot: project.staticRoot,
      ffmpeg: {
        found: ffmpeg.found,
        installHint: installHint(process.platform, readOsReleaseId()),
      },
      persistCache: args.cache !== false,
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ version: 1, project, ...report }, null, 2)}\n`);
      return;
    }
    console.log(formatAuditReport(report, { all: Boolean(args.all) }));
  }),
});

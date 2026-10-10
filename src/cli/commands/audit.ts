import { defineCommand } from "citty";
import { audit } from "../../core/commands/audit.js";
import { sharpImageEngine } from "../../core/engines/image.js";
import { svgoEngine } from "../../core/engines/svg.js";
import { guarded } from "../errors.js";
import { formatAuditReport } from "../format.js";
import { discover, ffmpegStatus, noAssetsMessage } from "../shared.js";

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
    const found = await discover(args._.map(String), args["out-dir"]);
    if (found.scanInputs.length === 0) {
      console.error(noAssetsMessage("audit", found.project));
      process.exitCode = 2;
      return;
    }

    const report = await audit({
      projectRoot: found.projectRoot,
      engine: sharpImageEngine,
      svgEngine: svgoEngine,
      inputs: found.scanInputs,
      outDir: found.outDir,
      staticRoot: found.project.staticRoot,
      ffmpeg: ffmpegStatus(),
      persistCache: args.cache !== false,
    });

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ version: 1, project: found.project, ...report }, null, 2)}\n`,
      );
      return;
    }
    console.log(formatAuditReport(report, { all: Boolean(args.all) }));
  }),
});

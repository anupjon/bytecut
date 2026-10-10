import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { explainFile, formatExplanation } from "../../core/config/explain.js";
import { sharpImageEngine } from "../../core/engines/image.js";
import { BytecutError } from "../../core/errors.js";
import { guarded } from "../errors.js";
import { configArg, createVideoEngine, discover } from "../shared.js";

export default defineCommand({
  meta: {
    name: "explain",
    description: "Show which rule chose a file's preset and what that preset resolves to",
  },
  args: {
    ...configArg,
    preset: { type: "string", description: "Show the result of forcing this preset" },
    json: { type: "boolean", description: "Print the explanation as JSON" },
    ffmpeg: { type: "string", description: "Path to the ffmpeg binary" },
    ffprobe: { type: "string", description: "Path to the ffprobe binary" },
  },
  run: guarded(async ({ args }) => {
    const files = args._.map(String);
    if (files.length === 0) {
      throw new BytecutError(
        "BAD_ARGUMENTS",
        "Name a file, e.g. `bytecut explain public/img/hero.jpg`.",
      );
    }
    const found = await discover([], undefined, args.config);
    const engine = createVideoEngine({ ffmpeg: args.ffmpeg, ffprobe: args.ffprobe }, found.config);

    const results = [];
    for (const file of files) {
      if (!(await stat(resolve(found.projectRoot, file)).catch(() => null))?.isFile()) {
        throw new BytecutError("INPUT_NOT_FOUND", `No such file: ${file}`);
      }
      results.push(
        await explainFile({
          projectRoot: found.projectRoot,
          file,
          config: found.config,
          engine: sharpImageEngine,
          videoEngine: engine,
          presetFlag: args.preset,
        }),
      );
    }

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ version: 1, files: results }, null, 2)}\n`);
      return;
    }
    const where = found.config.loaded ? found.config.loaded.name : "no config (zero-config)";
    console.log(`Config: ${where}\n`);
    console.log(results.map(formatExplanation).join("\n\n"));
  }),
});

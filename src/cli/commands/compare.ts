import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { defineCommand } from "citty";
import { startCompareServer } from "../../core/compare/index.js";
import { BytecutError } from "../../core/errors.js";
import { parseManifest } from "../../core/manifest/io.js";
import { MANIFEST_FILE } from "../../core/manifest/types.js";
import { toPosix } from "../../core/posix.js";
import { guarded } from "../errors.js";
import { configArg, discover } from "../shared.js";

export default defineCommand({
  meta: {
    name: "compare",
    description:
      "Serve a before/after page for one optimized file on localhost (127.0.0.1, random port)",
  },
  args: {
    ...configArg,
    port: { type: "string", description: "Port to listen on (default: a free one)" },
    "out-dir": { type: "string", description: "Output folder (default: from the framework)" },
  },
  run: guarded(async ({ args }) => {
    const inputs = args._.map(String);
    if (inputs.length !== 1) {
      throw new BytecutError(
        "BAD_ARGUMENTS",
        "Name one optimized file, e.g. `bytecut compare public/img/hero.jpg`.",
      );
    }
    let port = 0;
    if (args.port !== undefined) {
      port = Number(args.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new BytecutError("BAD_ARGUMENTS", `--port must be 0-65535, not "${args.port}".`);
      }
    }
    const found = await discover([], args["out-dir"], args.config);
    let text: string;
    try {
      text = await readFile(resolve(found.projectRoot, found.outDir, MANIFEST_FILE), "utf8");
    } catch {
      throw new BytecutError(
        "INPUT_NOT_FOUND",
        `No manifest at ${found.outDir}/${MANIFEST_FILE}. Run \`bytecut optimize -y\` first.`,
      );
    }
    const source = toPosix(relative(found.projectRoot, resolve(found.projectRoot, inputs[0]!)));
    const server = await startCompareServer({
      projectRoot: found.projectRoot,
      outDir: found.outDir,
      manifest: parseManifest(text),
      source,
      port,
    });

    // The page is never opened for the user: a headless command must not launch anything.
    console.log(`Comparing ${source}`);
    console.log(`  ${server.url}`);
    console.log("Local only (127.0.0.1). Press Ctrl-C to stop.");
    await new Promise<void>((done) => {
      process.once("SIGINT", () => done());
      process.once("SIGTERM", () => done());
    });
    await server.close();
  }),
});

import { relative } from "node:path";
import { defineCommand } from "citty";
import { applyChoices, isEmpty, renderConfig, type Choices } from "../../core/config/choices.js";
import { findConfigFiles } from "../../core/config/load.js";
import { FRAMEWORKS, PLACEHOLDERS } from "../../core/config/schema.js";
import { BytecutError } from "../../core/errors.js";
import { writeConfigFile } from "../../core/fs-safe.js";
import { detectProject, type Framework } from "../../core/scan/detect.js";
import { isGitIgnored } from "../../core/scan/gitignore.js";
import { resolve } from "node:path";
import { guarded } from "../errors.js";

const FILE = "bytecut.config.json";

export default defineCommand({
  meta: {
    name: "init",
    description: "Write a minimal bytecut.config.json containing only non-default choices",
  },
  args: {
    "out-dir": { type: "string", description: "Output folder to record" },
    "public-path": { type: "string", description: "URL prefix to record" },
    framework: { type: "string", description: `Framework to record (${FRAMEWORKS.join(", ")})` },
    placeholder: {
      type: "string",
      description: `Placeholder to record (${PLACEHOLDERS.join(", ")})`,
    },
  },
  run: guarded(async ({ args }) => {
    const projectRoot = process.cwd();
    const existing = await findConfigFiles(projectRoot);
    if (existing.length > 0) {
      throw new BytecutError(
        "CONFIG_EXISTS",
        `${existing[0]} already exists; edit it instead. init never overwrites a config.`,
      );
    }

    const framework = args.framework as string | undefined;
    if (framework !== undefined && !(FRAMEWORKS as readonly string[]).includes(framework)) {
      throw new BytecutError(
        "BAD_ARGUMENTS",
        `--framework must be one of ${FRAMEWORKS.join(", ")}.`,
      );
    }
    const placeholder = args.placeholder as string | undefined;
    if (placeholder !== undefined && !(PLACEHOLDERS as readonly string[]).includes(placeholder)) {
      throw new BytecutError(
        "BAD_ARGUMENTS",
        `--placeholder must be one of ${PLACEHOLDERS.join(", ")}.`,
      );
    }

    // Only what differs from what detection would choose is written.
    const detected = await detectProject(projectRoot);
    const effective = await detectProject(projectRoot, { framework: framework as Framework });
    const choices: Choices = {
      ...(args["out-dir"] && args["out-dir"] !== effective.outDir
        ? { outDir: args["out-dir"] }
        : {}),
      ...(args["public-path"] && args["public-path"] !== effective.publicPath
        ? { publicPath: args["public-path"] }
        : {}),
      ...(placeholder && placeholder !== "dominant-color"
        ? { placeholder: placeholder as Choices["placeholder"] }
        : {}),
    };
    const data = applyChoices(
      framework && framework !== detected.framework ? { framework } : {},
      choices,
    );

    const path = await writeConfigFile(projectRoot, FILE, renderConfig("json", data));
    console.log(
      isEmpty(choices) && !data.framework
        ? `Wrote ${relative(projectRoot, path)} with no overrides: everything is at its default.`
        : `Wrote ${relative(projectRoot, path)}:\n${renderConfig("json", data)}`,
    );

    // §7: point out, never change.
    const outDir = args["out-dir"] ?? effective.outDir;
    if (await isGitIgnored(projectRoot, resolve(projectRoot, outDir))) {
      console.warn(
        `Note: ${outDir} is matched by a .gitignore. bytecut's outputs are meant to be committed so deploys need no encoding step. Nothing was changed.`,
      );
    }
  }),
});

import { defineCommand, runMain } from "citty";
import pkg from "../../package.json" with { type: "json" };
import { guarded } from "./errors.js";
import { runDefault } from "./interactive.js";

const SUBCOMMANDS = ["audit", "optimize", "doctor"];

const main = defineCommand({
  meta: {
    name: "bytecut",
    version: pkg.version,
    description: "Audit and optimize images and videos in web projects",
  },
  // Plain `bytecut` (no subcommand): interactive UI on a TTY, audit report otherwise.
  // citty also invokes the parent's `run` after a subcommand finishes, so bail out then, or
  // every subcommand would be followed by a second, unrelated audit of the project.
  run: guarded(async ({ rawArgs }: { rawArgs: string[] }) => {
    const first = rawArgs.find((arg) => !arg.startsWith("-"));
    if (first !== undefined && SUBCOMMANDS.includes(first)) return;
    await runDefault();
  }),
  subCommands: {
    audit: () => import("./commands/audit.js").then((m) => m.default),
    optimize: () => import("./commands/optimize.js").then((m) => m.default),
    doctor: () => import("./commands/doctor.js").then((m) => m.default),
  },
});

await runMain(main);

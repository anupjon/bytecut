import { defineCommand, runMain } from "citty";
import pkg from "../../package.json" with { type: "json" };

const main = defineCommand({
  meta: {
    name: "bytecut",
    version: pkg.version,
    description: "Audit and optimize images and videos in web projects",
  },
  subCommands: {
    audit: () => import("./commands/audit.js").then((m) => m.default),
    optimize: () => import("./commands/optimize.js").then((m) => m.default),
    doctor: () => import("./commands/doctor.js").then((m) => m.default),
  },
});

await runMain(main);

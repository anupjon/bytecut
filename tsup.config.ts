import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli/index.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // sharp ships native binaries and must stay external.
  external: ["sharp"],
  banner: { js: "#!/usr/bin/env node" },
});

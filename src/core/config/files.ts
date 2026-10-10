/** In the order they are looked for; more than one present is an error, not a choice. */
export const CONFIG_FILES = [
  "bytecut.config.ts",
  "bytecut.config.mts",
  "bytecut.config.js",
  "bytecut.config.mjs",
  "bytecut.config.json",
  "bytecut.config.toml",
] as const;

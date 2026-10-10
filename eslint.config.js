import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "**/rust/target/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain-JS package: Node and WebAssembly globals that the TypeScript files get from types.
    files: ["packages/**/*.js"],
    languageOptions: { globals: { URL: "readonly", WebAssembly: "readonly" } },
  },
);

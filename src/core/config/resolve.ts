import type { Budgets, RuleSettings } from "../audit/types.js";
import { BytecutError } from "../errors.js";
import type { PlaceholderKind } from "../placeholders/types.js";
import type { PresetCatalog, PresetPolicy } from "../presets/catalog.js";
import { detectProject, type Framework, type ProjectInfo } from "../scan/detect.js";
import { matchesGlob } from "./glob.js";
import type { LoadedConfig } from "./load.js";
import { buildCatalog } from "./presets.js";
import { hint, type BytecutConfig } from "./schema.js";

export type Provenance = "config" | "detected";

/**
 * Everything the commands need, with the layers already merged: config over what was
 * detected over built-in defaults. Flags are applied by the caller on top of this, so the
 * precedence is flags > config > detection (§4).
 */
export interface ResolvedConfig {
  /** Null when there is no config; the rest is then exactly zero-config. */
  loaded: LoadedConfig | null;
  project: ProjectInfo;
  /** Where each project-level value came from, for `explain`. */
  provenance: {
    framework: Provenance;
    include: Provenance;
    outDir: Provenance;
    publicPath: Provenance;
  };
  /** .gitignore-style patterns for files to leave out of scans. */
  exclude: string[];
  catalog: PresetCatalog;
  policy: PresetPolicy;
  /** `assets` in the order written; first match wins. */
  assets: Array<{ pattern: string; preset: string }>;
  rules: RuleSettings;
  auditIgnore: string[];
  budgets: Budgets;
  placeholder: PlaceholderKind | "none" | undefined;
  concurrency: number | undefined;
  ffmpegPath: string | undefined;
  ffprobePath: string | undefined;
}

export function resolveConfigData(
  config: BytecutConfig,
  project: ProjectInfo,
  loaded: LoadedConfig | null,
): ResolvedConfig {
  const name = loaded?.name ?? "config";
  const catalog = buildCatalog(config.presets);

  const assets = Object.entries(config.assets ?? {}).map(([pattern, preset]) => ({
    pattern,
    preset,
  }));
  for (const { pattern, preset } of assets) {
    if (!catalog.image[preset] && !catalog.video[preset]) {
      const known = [...Object.keys(catalog.image), ...Object.keys(catalog.video)];
      throw new BytecutError(
        "CONFIG_INVALID",
        `${name}: assets["${pattern}"]: unknown preset "${preset}"${hint(preset, known)}. Known presets: ${known.join(", ")}.`,
      );
    }
  }

  const rules: RuleSettings = {};
  for (const [id, setting] of Object.entries(config.audit?.rules ?? {})) {
    rules[id] = setting as RuleSettings[string];
  }

  const budgets: Budgets = {};
  if (config.budgets?.maxFileSize !== undefined) budgets.maxFileBytes = config.budgets.maxFileSize;
  if (config.budgets?.maxTotalSize !== undefined)
    budgets.maxTotalBytes = config.budgets.maxTotalSize;

  return {
    loaded,
    project: {
      ...project,
      ...(config.include ? { include: config.include } : {}),
      ...(config.outDir ? { outDir: config.outDir } : {}),
      ...(config.publicPath ? { publicPath: config.publicPath } : {}),
    },
    provenance: {
      framework: config.framework ? "config" : "detected",
      include: config.include ? "config" : "detected",
      outDir: config.outDir ? "config" : "detected",
      publicPath: config.publicPath ? "config" : "detected",
    },
    exclude: config.exclude ?? [],
    catalog,
    policy: {
      catalog,
      assetFor: (source) => assets.find((rule) => matchesGlob(rule.pattern, source)),
    },
    assets,
    rules,
    auditIgnore: config.audit?.ignore ?? [],
    budgets,
    placeholder: config.manifest?.placeholder,
    concurrency: config.concurrency,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
  };
}

/** Detects the project, then merges the loaded config (if any) over it. */
export async function resolveConfig(
  projectRoot: string,
  loaded: LoadedConfig | null,
): Promise<ResolvedConfig> {
  const framework: Framework | undefined = loaded?.config.framework;
  const project = await detectProject(projectRoot, { framework });
  return resolveConfigData(loaded?.config ?? {}, project, loaded);
}

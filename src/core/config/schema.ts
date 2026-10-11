import { z } from "zod";
import { ALL_RULES } from "../audit/rules/index.js";
import { BytecutError } from "../errors.js";
import { parseSize } from "../units.js";

/**
 * The shape of bytecut.config (§4). Every field is optional and an empty config means
 * exactly what no config means. Unknown keys are errors, because a typo in a budget that is
 * silently ignored is a budget that silently does not apply.
 */

const M9 = "arrives with perceptual quality search in M9; use `target` for now";

const size = z.union([z.number().int().nonnegative(), z.string()]).transform((value, ctx) => {
  if (typeof value === "number") return value;
  const bytes = parseSize(value);
  if (bytes === null) {
    ctx.addIssue({ code: "custom", message: `"${value}" is not a size (try "250 KB" or 262144)` });
    return z.NEVER;
  }
  return bytes;
});

const severity = z.enum(["error", "warn", "info", "off"]);
const ruleSetting = z.union([severity, z.tuple([severity, z.record(z.string(), z.unknown())])]);

const quality = z.number().int().min(1).max(100);
export const TARGETS = ["low", "balanced", "high", "lossless"] as const;
export const PLACEHOLDERS = ["dominant-color", "lqip", "blurhash", "none"] as const;
export const FRAMEWORKS = ["next", "astro", "vite", "static"] as const;

const rejected = (what: string, why: string = M9) =>
  z
    .unknown()
    .optional()
    .superRefine((value, ctx) => {
      if (value !== undefined) ctx.addIssue({ code: "custom", message: `${what} ${why}` });
    });

const qualityByFormat = z
  .object({ jpg: quality.optional(), avif: quality.optional(), webp: quality.optional() })
  .strict();
const effortByFormat = z
  .object({
    avif: z.number().int().min(0).max(9).optional(),
    webp: z.number().int().min(0).max(6).optional(),
  })
  .strict();
const crfByCodec = z
  .object({
    av1: z.number().int().min(0).max(63).optional(),
    h264: z.number().int().min(0).max(51).optional(),
  })
  .strict();

/**
 * One preset definition. Image and video fields share a schema because which kind a preset
 * is depends on what it extends, which only the resolver knows; it checks fields against kind.
 */
export const presetSchema = z
  .object({
    extends: z.string().min(1).optional(),
    target: z.enum(TARGETS).optional(),
    // images
    widths: z.array(z.number().int().min(16).max(16384)).min(1).optional(),
    maxEdge: z.number().int().min(16).max(16384).optional(),
    formats: z
      .array(z.enum(["jpg", "png", "webp", "avif"]))
      .min(1)
      .optional(),
    quality: qualityByFormat.optional(),
    effort: effortByFormat.optional(),
    lossless: z.boolean().optional(),
    priority: z.boolean().optional(),
    // video
    audio: z.enum(["keep", "strip"]).optional(),
    maxWidth: z.number().int().min(16).nullable().optional(),
    maxFps: z.number().int().min(1).nullable().optional(),
    codecs: z
      .array(z.enum(["av1", "h264"]))
      .min(1)
      .optional(),
    crf: crfByCodec.optional(),
    // perceptual search: images and video; `floor` and `maxSize` cap a file's size (both)
    ssimulacra2: z.number().min(1).max(100).optional(),
    vmaf: z.number().min(1).max(100).optional(),
    floor: z.number().min(1).max(100).optional(),
    maxSize: size.optional(),
    // reserved
    raw: rejected("`raw`", "is not supported; use `target`, `quality` or `crf`"),
  })
  .strict()
  .superRefine((preset, ctx) => {
    const say = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (preset.maxEdge !== undefined && preset.widths !== undefined) {
      say(
        "maxEdge",
        "cannot be combined with `widths`: one caps the longest side, the other lists widths",
      );
    }
    if (preset.vmaf !== undefined && preset.ssimulacra2 !== undefined) {
      say("vmaf", "cannot be combined with `ssimulacra2`: a preset searches for one metric");
    }
    // The metric whose target `floor` and `maxSize` work against.
    const target = preset.ssimulacra2 ?? preset.vmaf;
    const metric = preset.ssimulacra2 !== undefined ? "ssimulacra2" : "vmaf";
    if (preset.floor !== undefined && target === undefined) {
      say(
        "floor",
        "needs `ssimulacra2` (or `vmaf` on a video preset): it is the lowest score allowed when `maxSize` forces quality down",
      );
    }
    if (preset.maxSize !== undefined && target === undefined) {
      say(
        "maxSize",
        "needs `ssimulacra2` (or `vmaf` on a video preset), so there is a quality target to hold while fitting the size",
      );
    }
    if (preset.maxSize !== undefined && preset.floor === undefined) {
      say(
        "floor",
        "is required with `maxSize`: how far quality may drop to fit is a tradeoff to state, not a default",
      );
    }
    if (preset.floor !== undefined && target !== undefined && preset.floor > target) {
      say("floor", `must not exceed \`${metric}\` (${target})`);
    }
    if (preset.floor !== undefined && preset.maxSize === undefined && target !== undefined) {
      say("floor", "only applies with `maxSize`");
    }
  });

const knownRuleIds = new Set(ALL_RULES.map((rule) => rule.id));

const auditSchema = z
  .object({
    rules: z
      .record(z.string(), ruleSetting)
      .superRefine((rules, ctx) => {
        for (const id of Object.keys(rules)) {
          if (!knownRuleIds.has(id)) {
            ctx.addIssue({
              code: "custom",
              path: [id],
              message: `unknown rule${hint(id, [...knownRuleIds])}`,
            });
          }
        }
      })
      .optional(),
    ignore: z.array(z.string().min(1)).optional(),
  })
  .strict();

const budgetsSchema = z
  .object({ maxFileSize: size.optional(), maxTotalSize: size.optional() })
  .strict();
const manifestSchema = z.object({ placeholder: z.enum(PLACEHOLDERS).optional() }).strict();

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
    outDir: z.string().min(1).optional(),
    publicPath: z
      .string()
      .regex(/^(\/|https?:\/\/)/, 'must start with "/" or be an http(s) URL')
      .optional(),
    framework: z.enum(FRAMEWORKS).optional(),
    assets: z.record(z.string().min(1), z.string().min(1)).optional(),
    presets: z.record(z.string().min(1), presetSchema).optional(),
    audit: auditSchema.optional(),
    budgets: budgetsSchema.optional(),
    manifest: manifestSchema.optional(),
    concurrency: z.number().int().min(1).max(16).optional(),
    ffmpegPath: z.string().min(1).optional(),
    ffprobePath: z.string().min(1).optional(),
    ssimulacra2Path: z.string().min(1).optional(),
  })
  .strict();

export type BytecutConfig = z.infer<typeof configSchema>;
export type PresetConfig = z.infer<typeof presetSchema>;

// ---- readable errors -------------------------------------------------------------------

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** ` (did you mean "x"?)` for the closest candidate within a small edit distance, else "". */
export function hint(wrong: string, candidates: string[]): string {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = distance(wrong.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [candidate, d];
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(wrong.length / 3))
    ? ` (did you mean "${best}"?)`
    : "";
}

/** The keys a strict object at `path` accepts, to suggest corrections for typos. */
function keysAt(path: ReadonlyArray<PropertyKey>): string[] {
  const p = path.map(String);
  if (p.length === 0) return Object.keys(configSchema.shape);
  if (p[0] === "presets") {
    if (p.length === 2) return Object.keys(presetSchema.shape);
    if (p[2] === "quality") return Object.keys(qualityByFormat.shape);
    if (p[2] === "effort") return Object.keys(effortByFormat.shape);
    if (p[2] === "crf") return Object.keys(crfByCodec.shape);
  }
  if (p[0] === "audit" && p.length === 1) return Object.keys(auditSchema.shape);
  if (p[0] === "budgets") return Object.keys(budgetsSchema.shape);
  if (p[0] === "manifest") return Object.keys(manifestSchema.shape);
  return [];
}

function describePath(path: ReadonlyArray<PropertyKey>): string {
  return path.length === 0 ? "(config)" : path.map(String).join(".");
}

export function formatConfigIssues(issues: z.core.$ZodIssue[]): string[] {
  const lines: string[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const known = keysAt(issue.path);
        lines.push(
          `${describePath(issue.path)}: unknown key "${key}"${hint(key, known)}${known.length ? ` — valid keys: ${known.join(", ")}` : ""}`,
        );
      }
    } else if (issue.code === "invalid_value" && issue.values.length > 0) {
      lines.push(
        `${describePath(issue.path)}: must be one of ${issue.values.map((v) => JSON.stringify(v)).join(", ")}`,
      );
    } else {
      lines.push(`${describePath(issue.path)}: ${issue.message}`);
    }
  }
  return lines;
}

/** Validates already-parsed data, throwing one error that lists every problem. */
export function parseConfig(raw: unknown, fileName: string): BytecutConfig {
  const result = configSchema.safeParse(raw);
  if (result.success) return result.data;
  const lines = formatConfigIssues(result.error.issues);
  throw new BytecutError(
    "CONFIG_INVALID",
    `${fileName} is not a valid bytecut config:\n${lines.map((l) => `  - ${l}`).join("\n")}`,
  );
}

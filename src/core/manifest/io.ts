import { z } from "zod";
import { BytecutError } from "../errors.js";
import { formatZodIssues } from "../plan/schema.js";
import { PLACEHOLDER_KINDS } from "../placeholders/types.js";
import { MANIFEST_MIN_VERSION, MANIFEST_VERSION, type Manifest } from "./types.js";

const outputSchema = z
  .object({
    path: z.string().min(1),
    url: z.string(),
    format: z.enum(["avif", "webp"]),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    lossless: z.boolean(),
    quality: z.number().int(),
    effort: z.number().int(),
    encoder: z.string(),
    status: z.enum(["written", "already-optimal", "stale"]),
    search: z
      .object({
        metric: z.literal("ssimulacra2"),
        target: z.number(),
        floor: z.number().optional(),
        maxBytes: z.number().int().optional(),
        plannedPath: z.string().optional(),
      })
      .strict()
      .optional(),
    score: z.number().optional(),
    scorer: z.enum(["wasm", "native"]).optional(),
  })
  .strict();

const placeholderSchema = z
  .object({ kind: z.enum(PLACEHOLDER_KINDS as [string, ...string[]]), value: z.string() })
  .strict();

const videoOutputSchema = z
  .object({
    path: z.string().min(1),
    url: z.string(),
    role: z.enum(["video", "poster"]),
    format: z.enum(["mp4", "avif"]),
    codec: z.enum(["av1", "h264"]).optional(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    fps: z.number().nonnegative().optional(),
    bytes: z.number().int().nonnegative(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    crf: z.number().int().optional(),
    speed: z.string().optional(),
    maxWidth: z.number().int().nullable().optional(),
    maxFps: z.number().nullable().optional(),
    audio: z.enum(["strip", "keep"]).optional(),
    quality: z.number().int().optional(),
    effort: z.number().int().optional(),
    at: z.number().optional(),
    codecs: z.string().optional(),
    encoder: z.string(),
    status: z.enum(["written", "already-optimal", "stale"]),
  })
  .strict();

const manifestSchema = z
  .object({
    version: z.union([z.literal(2), z.literal(3)]),
    tools: z.record(z.string(), z.string()),
    publicPath: z.string(),
    sources: z.record(
      z.string(),
      z
        .object({
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          bytes: z.number().int().nonnegative(),
          width: z.number().int().nonnegative(),
          height: z.number().int().nonnegative(),
          preset: z.string(),
          priority: z.boolean().optional(),
          placeholder: placeholderSchema.optional(),
          outputs: z.array(outputSchema),
        })
        .strict(),
    ),
    // Absent in version 2.
    videos: z
      .record(
        z.string(),
        z
          .object({
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            bytes: z.number().int().nonnegative(),
            width: z.number().int().nonnegative(),
            height: z.number().int().nonnegative(),
            durationSec: z.number().nonnegative(),
            preset: z.string(),
            priority: z.boolean().optional(),
            placeholder: placeholderSchema.optional(),
            outputs: z.array(videoOutputSchema),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/** A bad manifest is a hard error: guessing could orphan or clobber outputs (§6.6). */
export function parseManifest(text: string): Manifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BytecutError(
      "MANIFEST_INVALID",
      "bytecut-manifest.json is not valid JSON. Fix or delete it (outputs are regenerated from sources).",
    );
  }
  const version = (json as { version?: unknown } | null)?.version;
  if (typeof version === "number" && version < MANIFEST_MIN_VERSION) {
    throw new BytecutError(
      "MANIFEST_OUTDATED",
      `bytecut-manifest.json is version ${version}, written by a pre-release bytecut with an older output layout. Delete the output folder and re-run to regenerate it.`,
    );
  }
  if (typeof version === "number" && version > MANIFEST_VERSION) {
    throw new BytecutError(
      "MANIFEST_UNSUPPORTED",
      `bytecut-manifest.json is version ${version}, but this bytecut understands up to ${MANIFEST_VERSION}. Upgrade bytecut.`,
    );
  }
  const result = manifestSchema.safeParse(json);
  if (!result.success) {
    throw new BytecutError(
      "MANIFEST_INVALID",
      `bytecut-manifest.json is not a valid manifest: ${formatZodIssues(result.error)}`,
    );
  }
  // Upgrade in memory: a v2 manifest is a v3 one with no videos.
  return {
    ...result.data,
    version: MANIFEST_VERSION,
    videos: result.data.videos ?? {},
  } as Manifest;
}

/** Sorted keys and a trailing newline, so equal manifests are byte-identical. */
export function serializeManifest(manifest: Manifest): string {
  const sorted: Manifest = {
    version: manifest.version,
    tools: Object.fromEntries(Object.entries(manifest.tools).sort(([a], [b]) => (a < b ? -1 : 1))),
    publicPath: manifest.publicPath,
    sources: Object.fromEntries(
      Object.entries(manifest.sources).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    videos: Object.fromEntries(
      Object.entries(manifest.videos).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

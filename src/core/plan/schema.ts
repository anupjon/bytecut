import { z } from "zod";
import { BytecutError } from "../errors.js";
import type { Plan } from "./types.js";

/**
 * Plans can be loaded from disk (`--plan`), so every path is validated: sources and outputs
 * must be relative POSIX paths with no `..` segments, because they decide what is read and
 * where files land. fs-safe still enforces the write boundary independently.
 */
const safeRelativePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !/^[A-Za-z]:/.test(p) &&
      !p.includes("\\") &&
      p.split("/").every((s) => s !== "" && s !== "." && s !== ".."),
    "must be a relative POSIX path without '..' segments",
  );

const outputSchema = z
  .object({
    path: safeRelativePath,
    format: z.enum(["jpg", "png", "webp", "avif"]),
    width: z.number().int().positive(),
    lossless: z.boolean(),
    quality: z.number().int().min(1).max(100),
    effort: z.number().int().min(0).max(10),
    search: z
      .object({
        metric: z.literal("ssimulacra2"),
        target: z.number().min(1).max(100),
        floor: z.number().min(1).max(100).optional(),
        maxBytes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const itemSchema = z
  .object({
    source: safeRelativePath,
    sourceBytes: z.number().int().nonnegative(),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sourceWidth: z.number().int().nonnegative(),
    sourceHeight: z.number().int().nonnegative(),
    preset: z.string().min(1),
    classification: z
      .object({
        reason: z.string(),
        confidence: z.enum(["high", "medium", "low"]).optional(),
      })
      .strict()
      .optional(),
    outputs: z.array(outputSchema),
    skip: z.object({ reason: z.string() }).strict().optional(),
  })
  .strict();

const videoOutputSchema = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("video"),
      path: safeRelativePath,
      codec: z.enum(["av1", "h264"]),
      width: z.number().int().positive(),
      crf: z.number().int().min(0).max(63),
      speed: z.string().min(1),
      maxWidth: z.number().int().positive().nullable(),
      maxFps: z.number().positive().nullable(),
      audio: z.enum(["strip", "keep"]),
      audioBitrate: z.string().regex(/^\d+k$/),
      search: z
        .object({ metric: z.enum(["ssimulacra2", "vmaf"]), target: z.number().min(1).max(100) })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("poster"),
      path: safeRelativePath,
      format: z.literal("avif"),
      width: z.number().int().positive(),
      quality: z.number().int().min(1).max(100),
      effort: z.number().int().min(0).max(9),
      at: z.number().min(0).max(1),
    })
    .strict(),
]);

const videoItemSchema = z
  .object({
    source: safeRelativePath,
    sourceBytes: z.number().int().nonnegative(),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sourceWidth: z.number().int().nonnegative(),
    sourceHeight: z.number().int().nonnegative(),
    durationSec: z.number().nonnegative(),
    fps: z.number().nonnegative(),
    hasAudio: z.boolean(),
    videoCodec: z.string(),
    preset: z.string().min(1),
    classification: z
      .object({
        reason: z.string(),
        confidence: z.enum(["high", "medium", "low"]).optional(),
      })
      .strict()
      .optional(),
    outputs: z.array(videoOutputSchema),
    skip: z.object({ reason: z.string() }).strict().optional(),
  })
  .strict();

export const planSchema = z
  .object({
    version: z.literal(1),
    // May legitimately contain `..` (an output folder beside the project); SafeFs validates it.
    outDir: z
      .string()
      .min(1)
      .refine((p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.includes("\\")),
    publicPath: z.string().min(1),
    items: z.array(itemSchema),
    videos: z.array(videoItemSchema).optional(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    const outputs = [
      ...plan.items.flatMap((i) => i.outputs),
      ...(plan.videos ?? []).flatMap((v) => v.outputs),
    ];
    for (const out of outputs) {
      if (seen.has(out.path)) {
        ctx.addIssue({ code: "custom", message: `duplicate output path ${out.path}` });
      }
      seen.add(out.path);
    }
  });

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export function parsePlan(text: string, origin = "plan"): Plan {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BytecutError("PLAN_INVALID", `${origin} is not valid JSON.`);
  }
  const result = planSchema.safeParse(json);
  if (!result.success) {
    throw new BytecutError(
      "PLAN_INVALID",
      `${origin} is not a valid bytecut plan: ${formatZodIssues(result.error)}`,
    );
  }
  return result.data;
}

/** Stable text form: 2-space indent and a trailing newline, so saved plans diff cleanly. */
export function serializePlan(plan: Plan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

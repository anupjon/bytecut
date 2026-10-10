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
    format: z.enum(["avif", "webp"]),
    width: z.number().int().positive(),
    lossless: z.boolean(),
    quality: z.number().int().min(1).max(100),
    effort: z.number().int().min(0).max(9),
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
  })
  .strict()
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    for (const item of plan.items) {
      for (const out of item.outputs) {
        if (seen.has(out.path)) {
          ctx.addIssue({ code: "custom", message: `duplicate output path ${out.path}` });
        }
        seen.add(out.path);
      }
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

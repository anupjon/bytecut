import type { AuditContext, ImageFacts } from "../types.js";

/** Options for a rule: its defaults, overridden by whatever the settings supplied. */
export function ruleOptions<T extends Record<string, unknown>>(
  ctx: AuditContext,
  id: string,
  defaults: T,
): T {
  return { ...defaults, ...ctx.options(id) } as T;
}

/**
 * Source-level issues (legacy format, oversized, heavy, ...) are resolved once up-to-date
 * outputs exist, because the sources are never modified but the served files are. Rules skip
 * covered images so a finished project audits clean.
 */
export function isCovered(image: ImageFacts): boolean {
  return image.cache.kind === "hit";
}

/** Estimated saving of replacing the source with its best planned output. */
export function savingOf(image: ImageFacts): number | undefined {
  if (!image.estimate) return undefined;
  return Math.max(0, image.bytes - image.estimate.best.bytes);
}

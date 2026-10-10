import type { AuditRule, Finding } from "../types.js";
import { isCovered, ruleOptions, savingOf } from "./helpers.js";

const ID = "image/oversized-dimensions";

export const oversizedDimensions: AuditRule = {
  id: ID,
  category: "image",
  defaultSeverity: "warn",
  fix: null,

  async check(ctx) {
    const { maxDimension } = ruleOptions(ctx, ID, { maxDimension: 2560 });
    const findings: Finding[] = [];
    for (const image of ctx.images) {
      const { width, height } = image.analysis;
      if (Math.max(width, height) <= maxDimension || isCovered(image)) continue;
      const cap = image.estimate?.best.width;
      const saving = savingOf(image);
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: image.source,
        message: `${width}x${height} exceeds ${maxDimension}px${cap ? `; outputs are capped at ${cap}w` : ""}`,
        current: image.bytes,
        ...(image.estimate ? { estimated: image.estimate.best.bytes } : {}),
        ...(saving !== undefined ? { savingsBytes: saving } : {}),
      });
    }
    return findings;
  },
};

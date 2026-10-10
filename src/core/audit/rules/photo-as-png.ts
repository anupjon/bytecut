import type { AuditRule, Finding } from "../types.js";
import { isCovered, ruleOptions, savingOf } from "./helpers.js";

const ID = "image/photo-as-png";

export const photoAsPng: AuditRule = {
  id: ID,
  category: "image",
  defaultSeverity: "warn",
  fix: "optimize",

  async check(ctx) {
    const { minColors } = ruleOptions(ctx, ID, { minColors: 128 });
    const findings: Finding[] = [];
    for (const image of ctx.images) {
      const a = image.analysis;
      if (a.format !== "png" || a.alphaUsed || isCovered(image)) continue;
      // Only continuous-tone content: flat art is rightly a PNG.
      if (image.classification.preset === "icon" || a.colorCount < minColors) continue;
      const saving = savingOf(image);
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: image.source,
        message: `photographic content stored as PNG (${a.colorCount} colours in sample, no transparency)`,
        current: image.bytes,
        ...(image.estimate ? { estimated: image.estimate.best.bytes } : {}),
        ...(saving !== undefined ? { savingsBytes: saving } : {}),
      });
    }
    return findings;
  },
};

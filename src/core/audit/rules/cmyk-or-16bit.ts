import type { AuditRule, Finding } from "../types.js";
import { isCovered } from "./helpers.js";

const ID = "image/cmyk-or-16bit";

export const cmykOr16bit: AuditRule = {
  id: ID,
  category: "image",
  defaultSeverity: "warn",
  fix: "optimize",

  async check(ctx) {
    const findings: Finding[] = [];
    for (const image of ctx.images) {
      const { space, depth } = image.analysis;
      const cmyk = space === "cmyk";
      const deep =
        depth === "ushort" || depth === "uint" || depth === "float" || depth === "double";
      if ((!cmyk && !deep) || isCovered(image)) continue;
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: image.source,
        message: cmyk
          ? "CMYK colour space renders wrongly in browsers; outputs are converted to sRGB"
          : "16-bit depth is wasted on the web; outputs are 8-bit",
        current: image.bytes,
        ...(image.estimate ? { estimated: image.estimate.best.bytes } : {}),
      });
    }
    return findings;
  },
};

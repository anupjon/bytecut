import type { AuditRule, Finding } from "../types.js";
import { ruleOptions } from "./helpers.js";

const ID = "svg/embedded-raster";

export const svgEmbeddedRaster: AuditRule = {
  id: ID,
  category: "svg",
  defaultSeverity: "warn",
  fix: null,

  async check(ctx) {
    const { minBytes } = ruleOptions(ctx, ID, { minBytes: 1024 });
    const findings: Finding[] = [];
    for (const svg of ctx.svgs) {
      if (svg.embeddedRasterCount === 0 || svg.embeddedRasterBytes < minBytes) continue;
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: svg.source,
        message: `embeds ${svg.embeddedRasterCount} raster image${svg.embeddedRasterCount === 1 ? "" : "s"} as base64 (${svg.embeddedRasterBytes} bytes); extract and optimize ${svg.embeddedRasterCount === 1 ? "it" : "them"} separately`,
        current: svg.bytes,
      });
    }
    return findings;
  },
};

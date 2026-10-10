import type { AuditRule, Finding } from "../types.js";
import { isCovered, ruleOptions } from "./helpers.js";

const ID = "image/metadata";

export const metadata: AuditRule = {
  id: ID,
  category: "image",
  defaultSeverity: "info",
  fix: null,

  async check(ctx) {
    const { minBytes } = ruleOptions(ctx, ID, { minBytes: 1024 });
    const findings: Finding[] = [];
    for (const image of ctx.images) {
      const m = image.analysis.metadata;
      const bytes = m.exif + m.xmp + m.iptc;
      if ((bytes < minBytes && !m.gps) || isCovered(image)) continue;
      findings.push({
        ruleId: ID,
        severity: "info",
        source: image.source,
        message: m.gps
          ? "carries embedded metadata including GPS location; outputs strip it"
          : "carries embedded metadata (EXIF/XMP/IPTC); outputs strip it",
        current: image.bytes,
        savingsBytes: bytes,
      });
    }
    return findings;
  },
};

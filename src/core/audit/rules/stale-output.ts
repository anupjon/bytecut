import { checkCache, type CacheMissReason } from "../../manifest/cache.js";
import type { AuditRule, Finding, ProjectContext } from "../types.js";

const ID = "project/stale-output";

// A modified output is the one case that is not regenerated automatically: it is left alone
// until --force, so the message must not promise otherwise (§6.6).
const REASONS: Record<Exclude<CacheMissReason, "new">, string> = {
  "source-changed": "source changed since the last run; will be regenerated",
  "outputs-differ": "preset or widths differ from what was last generated; will be regenerated",
  "output-missing": "an output file is missing; will be regenerated",
  "output-modified":
    "an output file was modified after it was written; it is left alone unless you use --force",
  "output-stale":
    "an output was left over from an older source (a run did not complete); will be regenerated",
};

export const staleOutput: AuditRule<ProjectContext> = {
  id: ID,
  category: "project",
  defaultSeverity: "warn",
  fix: null,

  async check(ctx) {
    const findings: Finding[] = [];
    if (!ctx.manifest) return findings;

    for (const item of ctx.plan.items) {
      if (item.skip) continue;
      const entry = ctx.manifest.sources[item.source];
      const state = await checkCache(item, entry, ctx.outputHash);
      if (state.kind === "miss" && state.reason !== "new") {
        findings.push({
          ruleId: ID,
          severity: "warn",
          source: item.source,
          message: REASONS[state.reason],
        });
        continue;
      }

      // Cached, but made by a different encoder than the one installed now. We don't re-encode
      // on this alone (same hash + same preset = skip), so say how to opt in.
      for (const out of entry?.outputs ?? []) {
        const current = ctx.encoders[out.format];
        if (out.status === "written" && out.encoder !== current) {
          findings.push({
            ruleId: ID,
            severity: "warn",
            source: item.source,
            path: out.path,
            message: `encoded with ${out.encoder}, installed is ${current}; run with --force to regenerate`,
          });
        }
      }
    }
    return findings;
  },
};

import type { AuditRule, Finding } from "../types.js";

const ID = "project/duplicate";

export const duplicate: AuditRule = {
  id: ID,
  category: "project",
  defaultSeverity: "warn",
  fix: null,

  async check(ctx) {
    const groups = new Map<string, Array<{ source: string; bytes: number }>>();
    for (const file of [...ctx.images, ...ctx.svgs]) {
      const list = groups.get(file.sha256) ?? [];
      list.push({ source: file.source, bytes: file.bytes });
      groups.set(file.sha256, list);
    }

    const findings: Finding[] = [];
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => (a.source < b.source ? -1 : 1));
      const [first, ...copies] = list;
      findings.push({
        ruleId: ID,
        severity: "warn",
        source: first!.source,
        message: `identical content in ${copies.length} other file${copies.length === 1 ? "" : "s"}: ${copies.map((c) => c.source).join(", ")}`,
        current: first!.bytes * list.length,
        savingsBytes: first!.bytes * copies.length,
      });
    }
    return findings;
  },
};

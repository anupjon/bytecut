import { PROJECT_RULES } from "./rules/index.js";
import type { Finding, ProjectContext } from "./types.js";

export function sortFindings(findings: Finding[]): Finding[] {
  const key = (f: Finding) => `${f.ruleId}\0${f.source ?? ""}\0${f.path ?? ""}\0${f.message}`;
  return findings.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Runs the manifest-based project rules; results are sorted so output is stable. */
export async function runProjectRules(ctx: ProjectContext): Promise<Finding[]> {
  const all: Finding[] = [];
  for (const rule of PROJECT_RULES) all.push(...(await rule.check(ctx)));
  return sortFindings(all);
}

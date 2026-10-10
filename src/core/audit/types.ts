import type { Classification } from "../classify/classify.js";
import type { ImageAnalysis } from "../engines/types.js";
import type { CacheState } from "../manifest/cache.js";
import type { Manifest } from "../manifest/types.js";
import type { Plan, PlanItem } from "../plan/types.js";
import type { ImageFormat } from "../presets/photo.js";
import type { ItemEstimate } from "./estimate.js";

export type Severity = "error" | "warn" | "info" | "off";

export interface Finding {
  ruleId: string;
  severity: Exclude<Severity, "off">;
  /** Source path (relative to the project root) the finding is about, if any. */
  source?: string;
  /** Output path (relative to outDir), if the finding is about one file. */
  path?: string;
  /** Short and free of byte counts: sizes are structured so each front end formats them. */
  message: string;
  /** Bytes of the file today and what it is estimated to become. */
  current?: number;
  estimated?: number;
  /** Estimated saving; may be set without `estimated` (e.g. metadata, duplicates). */
  savingsBytes?: number;
}

/** What the M2 manifest rules need; also available to every other rule. */
export interface ProjectContext {
  plan: Plan;
  manifest: Manifest | null;
  /** Encoder strings the current engine would record, per format. */
  encoders: Record<ImageFormat, string>;
  /** Whether a source path (relative to the project root) still exists on disk. */
  sourceExists(source: string): Promise<boolean>;
  /** sha256 of an output file, or null if it doesn't exist. */
  outputHash(path: string): Promise<string | null>;
}

export interface ImageFacts {
  source: string;
  bytes: number;
  sha256: string;
  analysis: ImageAnalysis;
  classification: Classification;
  item: PlanItem;
  /** `hit` means up-to-date outputs already exist, so source-level issues are resolved. */
  cache: CacheState;
  estimate: ItemEstimate | null;
}

export interface SvgFacts {
  source: string;
  bytes: number;
  sha256: string;
  /** Size after svgo, or null if svgo could not parse it. */
  minifiedBytes: number | null;
  embeddedRasterBytes: number;
  embeddedRasterCount: number;
}

export interface Budgets {
  /** Largest allowed size, in bytes, of any single served image. */
  maxFileBytes?: number;
  /** Largest allowed total of all served images, in bytes. */
  maxTotalBytes?: number;
}

export interface AuditContext extends ProjectContext {
  images: ImageFacts[];
  /** Raster files the plan could not process (animated, corrupt, unsupported). */
  skipped: Array<{ source: string; bytes: number; reason: string; animatedGif: boolean }>;
  svgs: SvgFacts[];
  videos: string[];
  /** Lowercased image basenames referenced from project text files; null if not scanned. */
  references: Set<string> | null;
  budgets: Budgets;
  ffmpeg: { found: boolean; installHint: string };
  /** Per-rule options from settings, merged over each rule's defaults by the rule. */
  options(ruleId: string): Record<string, unknown>;
}

/**
 * One file per rule (§5). `fix` is null where `optimize` can't yet apply the fix; the engine
 * that applies fixes arrives with the later milestones.
 */
export interface AuditRule<C extends ProjectContext = AuditContext> {
  id: string;
  category: "image" | "svg" | "gif" | "project";
  defaultSeverity: Exclude<Severity, "off">;
  check(ctx: C): Promise<Finding[]>;
  fix: null;
}

/** ESLint-style: a severity, or `[severity, options]`. */
export type RuleSetting = Severity | [Severity, Record<string, unknown>];
export type RuleSettings = Record<string, RuleSetting>;

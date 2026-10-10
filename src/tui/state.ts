import type { Finding } from "../core/audit/types.js";
import type { AuditPhase } from "../core/commands/audit.js";
import type { OutputResult, RunResult, VideoOutputResult } from "../core/execute/run.js";
import type { Plan } from "../core/plan/types.js";
import { defaultSelection, type Model, type Row } from "./model.js";

export type View = "scanning" | "list" | "review" | "running" | "done" | "error";
export type Overlay = null | "help" | "details" | "outdir" | "command" | "doctor";

export const PRESET_CYCLE = ["photo", "hero", "icon"] as const;

export interface ReviewItem {
  source: string;
  preset: string;
  /** `new`/`changed` will be encoded; `unchanged` is already up to date and skipped. */
  state: "encode" | "unchanged" | "skipped";
  outputs: number;
  note?: string;
}

export interface Review {
  plan: Plan;
  items: ReviewItem[];
  willEncode: number;
  unchanged: number;
  outputs: number;
  findings: Finding[];
}

export interface RunProgress {
  total: number;
  done: number;
  current: string | null;
  /** One line per resolved output, newest last. */
  log: Array<{ source: string; output: OutputResult | VideoOutputResult }>;
  /** Latest encode progress per video output path, 0..1. */
  progress: Record<string, number>;
}

export interface State {
  view: View;
  /** Bumped to request a (re)scan; the app runs the audit whenever it changes. */
  scanId: number;
  overlay: Overlay;
  scan: { phase: AuditPhase; done: number; total: number } | null;
  model: Model;
  /** Source paths of every file in the project the `@` picker can offer. */
  files: string[];
  selected: Set<string>;
  cursor: number;
  /** Per-file preset overrides (source → preset name). */
  presets: Record<string, string>;
  outDir: string;
  /** Text in the command bar or the outDir prompt. */
  input: string;
  suggestion: number;
  review: Review | null;
  run: RunProgress | null;
  result: RunResult | null;
  cancelling: boolean;
  status: string | null;
  error: string | null;
}

export const EMPTY_MODEL: Model = { rows: [], reportOnly: [], covered: 0, skipped: [], notes: [] };

export function initialState(outDir: string): State {
  return {
    view: "scanning",
    scanId: 0,
    overlay: null,
    scan: null,
    model: EMPTY_MODEL,
    files: [],
    selected: new Set(),
    cursor: 0,
    presets: {},
    outDir,
    input: "",
    suggestion: 0,
    review: null,
    run: null,
    result: null,
    cancelling: false,
    status: null,
    error: null,
  };
}

export type Action =
  | { type: "scan-progress"; phase: AuditPhase; done: number; total: number }
  | { type: "scan-done"; model: Model; files: string[] }
  | { type: "fatal"; error: string }
  | { type: "move"; delta: number }
  | { type: "toggle" }
  | { type: "toggle-all" }
  | { type: "select"; mode: "all" | "none" | "warn" }
  | { type: "select-files"; sources: string[] }
  | { type: "cursor-to"; source: string }
  | { type: "cycle-preset"; sources?: string[]; to?: string }
  | { type: "overlay"; overlay: Overlay; input?: string }
  | { type: "input"; text: string }
  | { type: "suggest"; delta: number; max: number }
  | { type: "set-out-dir"; outDir: string }
  | { type: "review-ready"; review: Review }
  | { type: "run-start"; total: number }
  | { type: "run-item-start"; source: string }
  | { type: "run-output"; source: string; output: OutputResult | VideoOutputResult }
  | { type: "run-progress"; path: string; fraction: number }
  | { type: "run-item-done" }
  | { type: "run-done"; result: RunResult }
  | { type: "rescan" }
  | { type: "cancel" }
  | { type: "back" }
  | { type: "status"; message: string | null };

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function rowAt(state: State): Row | undefined {
  return state.model.rows[state.cursor];
}

/** The preset a row will run with: the user's override, else the classifier's verdict. */
export function effectivePreset(state: State, row: Row): string {
  return state.presets[row.source] ?? row.preset;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "scan-progress":
      return { ...state, scan: { phase: action.phase, done: action.done, total: action.total } };

    case "scan-done":
      return {
        ...state,
        view: "list",
        overlay: null,
        scan: null,
        model: action.model,
        files: action.files,
        selected: defaultSelection(action.model.rows),
        cursor: 0,
        review: null,
        result: null,
        run: null,
        cancelling: false,
        status: null,
      };

    case "fatal":
      return { ...state, view: "error", error: action.error };

    case "move": {
      const last = Math.max(0, state.model.rows.length - 1);
      return { ...state, cursor: clamp(state.cursor + action.delta, 0, last) };
    }

    case "toggle": {
      const row = rowAt(state);
      if (!row) return state;
      const selected = new Set(state.selected);
      if (selected.has(row.source)) selected.delete(row.source);
      else selected.add(row.source);
      return { ...state, selected };
    }

    case "toggle-all": {
      const all = state.model.rows.every((r) => state.selected.has(r.source));
      return {
        ...state,
        selected: all ? new Set() : new Set(state.model.rows.map((r) => r.source)),
      };
    }

    case "select": {
      const rows = state.model.rows;
      const sources =
        action.mode === "all"
          ? rows.map((r) => r.source)
          : action.mode === "none"
            ? []
            : rows.filter((r) => r.severity !== "info").map((r) => r.source);
      return { ...state, selected: new Set(sources) };
    }

    case "select-files": {
      const known = new Set(state.model.rows.map((r) => r.source));
      return { ...state, selected: new Set(action.sources.filter((s) => known.has(s))) };
    }

    case "cursor-to": {
      const at = state.model.rows.findIndex((r) => r.source === action.source);
      return at === -1 ? state : { ...state, cursor: at };
    }

    case "cycle-preset": {
      const targets = action.sources ?? (rowAt(state) ? [rowAt(state)!.source] : []);
      if (targets.length === 0) return state;
      const presets = { ...state.presets };
      for (const source of targets) {
        const row = state.model.rows.find((r) => r.source === source);
        if (!row) continue;
        const current = presets[source] ?? row.preset;
        const next =
          action.to ??
          PRESET_CYCLE[(PRESET_CYCLE.indexOf(current as never) + 1) % PRESET_CYCLE.length]!;
        if (next === row.preset) delete presets[source];
        else presets[source] = next;
      }
      return { ...state, presets };
    }

    case "overlay":
      return {
        ...state,
        overlay: action.overlay,
        input: action.input ?? "",
        suggestion: 0,
        status: null,
      };

    case "input":
      return { ...state, input: action.text, suggestion: 0 };

    case "suggest":
      return {
        ...state,
        suggestion: clamp(state.suggestion + action.delta, 0, Math.max(0, action.max - 1)),
      };

    case "set-out-dir":
      return { ...state, outDir: action.outDir, overlay: null, input: "", review: null };

    case "review-ready":
      return { ...state, view: "review", overlay: null, review: action.review, status: null };

    case "run-start":
      return {
        ...state,
        view: "running",
        overlay: null,
        cancelling: false,
        run: { total: action.total, done: 0, current: null, log: [], progress: {} },
      };

    case "run-item-start":
      return state.run ? { ...state, run: { ...state.run, current: action.source } } : state;

    case "run-output":
      return state.run
        ? {
            ...state,
            run: {
              ...state.run,
              log: [...state.run.log, { source: action.source, output: action.output }],
            },
          }
        : state;

    case "run-progress":
      return state.run
        ? {
            ...state,
            run: {
              ...state.run,
              progress: { ...state.run.progress, [action.path]: action.fraction },
            },
          }
        : state;

    case "run-item-done":
      return state.run ? { ...state, run: { ...state.run, done: state.run.done + 1 } } : state;

    case "run-done":
      return { ...state, view: "done", result: action.result, cancelling: false };

    case "rescan":
      return { ...state, view: "scanning", scanId: state.scanId + 1, scan: null, overlay: null };

    case "cancel":
      return state.view === "running" ? { ...state, cancelling: true } : state;

    case "back": {
      if (state.overlay) return { ...state, overlay: null, input: "", status: null };
      switch (state.view) {
        case "review":
          return { ...state, view: "list", review: null };
        case "running":
          return { ...state, cancelling: true };
        case "done":
          // Outputs changed, so the list is stale: leave by rescanning.
          return {
            ...state,
            view: "scanning",
            scanId: state.scanId + 1,
            result: null,
            run: null,
            scan: null,
          };
        default:
          return state;
      }
    }

    case "status":
      return { ...state, status: action.message };
  }
}

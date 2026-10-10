import { describe, expect, it } from "vitest";
import type { Model, Row } from "../../../src/tui/model.js";
import {
  initialState,
  reducer,
  rowAt,
  effectivePreset,
  type Action,
  type State,
} from "../../../src/tui/state.js";

const row = (source: string, over: Partial<Row> = {}): Row => ({
  source,
  bytes: 1000,
  width: 800,
  height: 600,
  preset: "photo",
  reason: "r",
  estimatedBytes: 100,
  savingsBytes: 900,
  plannedOutputs: 2,
  findings: [],
  severity: "warn",
  ...over,
});

const model = (rows: Row[]): Model => ({
  rows,
  reportOnly: [],
  covered: 0,
  skipped: [],
  notes: [],
});

function loaded(rows: Row[]): State {
  return reducer(initialState("out"), {
    type: "scan-done",
    model: model(rows),
    files: rows.map((r) => r.source),
  });
}

const run = (state: State, ...actions: Action[]) => actions.reduce(reducer, state);
const abc = () => loaded([row("a.jpg"), row("b.jpg", { severity: "info" }), row("c.jpg")]);

describe("scanning", () => {
  it("starts in scanning and records progress", () => {
    const s = reducer(initialState("out"), {
      type: "scan-progress",
      phase: "analyze",
      done: 3,
      total: 9,
    });
    expect(s.view).toBe("scanning");
    expect(s.scan).toEqual({ phase: "analyze", done: 3, total: 9 });
  });

  it("scan-done opens the list with the default selection and cursor at the top", () => {
    const s = abc();
    expect(s.view).toBe("list");
    expect([...s.selected].sort()).toEqual(["a.jpg", "c.jpg"]);
    expect(s.cursor).toBe(0);
  });

  it("a fatal error moves to the error view", () => {
    expect(reducer(abc(), { type: "fatal", error: "boom" })).toMatchObject({
      view: "error",
      error: "boom",
    });
  });
});

describe("list navigation and selection", () => {
  it("moves within bounds", () => {
    expect(run(abc(), { type: "move", delta: -1 }).cursor).toBe(0);
    expect(run(abc(), { type: "move", delta: 1 }).cursor).toBe(1);
    expect(run(abc(), { type: "move", delta: 99 }).cursor).toBe(2);
  });

  it("toggles the highlighted row only", () => {
    const s = run(abc(), { type: "toggle" });
    expect(s.selected.has("a.jpg")).toBe(false);
    expect(s.selected.has("c.jpg")).toBe(true);
    const back = run(s, { type: "toggle" });
    expect(back.selected.has("a.jpg")).toBe(true);
  });

  it("toggle-all selects everything, then clears when everything is selected", () => {
    const all = run(abc(), { type: "toggle-all" });
    expect(all.selected.size).toBe(3);
    expect(run(all, { type: "toggle-all" }).selected.size).toBe(0);
  });

  it("select modes", () => {
    const s = abc();
    expect(run(s, { type: "select", mode: "all" }).selected.size).toBe(3);
    expect(run(s, { type: "select", mode: "none" }).selected.size).toBe(0);
    expect(
      [
        ...run(s, { type: "select", mode: "none" }, { type: "select", mode: "warn" }).selected,
      ].sort(),
    ).toEqual(["a.jpg", "c.jpg"]);
  });

  it("select-files ignores sources that are not in the list", () => {
    const s = run(abc(), { type: "select-files", sources: ["b.jpg", "ghost.jpg"] });
    expect([...s.selected]).toEqual(["b.jpg"]);
  });

  it("cursor-to jumps to a file and ignores unknown ones", () => {
    expect(run(abc(), { type: "cursor-to", source: "c.jpg" }).cursor).toBe(2);
    expect(run(abc(), { type: "cursor-to", source: "zzz" }).cursor).toBe(0);
  });

  it("does not crash on an empty list", () => {
    const s = loaded([]);
    expect(run(s, { type: "move", delta: 1 }, { type: "toggle" }).cursor).toBe(0);
    expect(rowAt(s)).toBeUndefined();
  });
});

describe("presets", () => {
  it("cycles the highlighted row through photo → hero → icon → photo", () => {
    let s = abc();
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      s = run(s, { type: "cycle-preset" });
      seen.push(effectivePreset(s, rowAt(s)!));
    }
    expect(seen).toEqual(["hero", "icon", "photo", "hero"]);
  });

  it("drops the override when it returns to the classifier's verdict", () => {
    const s = run(
      abc(),
      { type: "cycle-preset", to: "hero" },
      { type: "cycle-preset", to: "photo" },
    );
    expect(s.presets).toEqual({});
  });

  it("sets an explicit preset for several files at once", () => {
    const s = run(abc(), { type: "cycle-preset", sources: ["a.jpg", "c.jpg"], to: "icon" });
    expect(s.presets).toEqual({ "a.jpg": "icon", "c.jpg": "icon" });
  });

  it("ignores files that are not in the list", () => {
    expect(run(abc(), { type: "cycle-preset", sources: ["nope.jpg"], to: "icon" }).presets).toEqual(
      {},
    );
  });
});

describe("overlays and the command bar", () => {
  it("opens an overlay with initial input and esc closes it, clearing status", () => {
    let s = run(
      abc(),
      { type: "status", message: "oops" },
      { type: "overlay", overlay: "command", input: "/" },
    );
    expect(s).toMatchObject({ overlay: "command", input: "/", status: null });
    s = run(s, { type: "status", message: "bad" }, { type: "back" });
    expect(s).toMatchObject({ overlay: null, input: "", status: null });
  });

  it("clamps the suggestion index", () => {
    let s = run(abc(), { type: "overlay", overlay: "command", input: "/" });
    s = run(s, { type: "suggest", delta: 99, max: 3 });
    expect(s.suggestion).toBe(2);
    s = run(s, { type: "suggest", delta: -99, max: 3 });
    expect(s.suggestion).toBe(0);
  });

  it("typing resets the suggestion", () => {
    const s = run(
      abc(),
      { type: "overlay", overlay: "command", input: "/" },
      { type: "suggest", delta: 2, max: 5 },
      { type: "input", text: "/p" },
    );
    expect(s.suggestion).toBe(0);
  });
});

describe("review → run → done", () => {
  const review = {
    plan: { version: 1 as const, outDir: "out", publicPath: "/_bytecut", items: [] },
    items: [],
    willEncode: 2,
    unchanged: 0,
    outputs: 4,
    findings: [],
  };

  it("review-ready opens the review and esc returns to the list", () => {
    let s = run(abc(), { type: "review-ready", review });
    expect(s.view).toBe("review");
    s = run(s, { type: "back" });
    expect(s.view).toBe("list");
    expect(s.review).toBeNull();
  });

  it("tracks progress and finishes", () => {
    let s = run(
      abc(),
      { type: "review-ready", review },
      { type: "run-start", total: 2 },
      { type: "run-item-start", source: "a.jpg" },
    );
    expect(s.run).toMatchObject({ total: 2, done: 0, current: "a.jpg" });
    s = run(s, { type: "run-item-done" }, { type: "run-item-done" });
    expect(s.run!.done).toBe(2);
    s = run(s, { type: "run-done", result: { items: [], cancelled: false, warnings: [] } });
    expect(s.view).toBe("done");
  });

  it("esc while running requests cancellation but stays in the running view", () => {
    const s = run(abc(), { type: "run-start", total: 1 }, { type: "back" });
    expect(s).toMatchObject({ view: "running", cancelling: true });
  });

  it("leaving the done screen rescans, because the outputs changed", () => {
    const before = run(
      abc(),
      { type: "run-start", total: 1 },
      {
        type: "run-done",
        result: { items: [], cancelled: false, warnings: [] },
      },
    );
    const s = run(before, { type: "back" });
    expect(s.view).toBe("scanning");
    expect(s.scanId).toBe(before.scanId + 1);
    expect(s.result).toBeNull();
  });

  it("an output-folder change drops the review and a rescan is requested separately", () => {
    const s = run(
      abc(),
      { type: "review-ready", review },
      { type: "set-out-dir", outDir: "elsewhere" },
    );
    expect(s.outDir).toBe("elsewhere");
    expect(s.review).toBeNull();
  });
});

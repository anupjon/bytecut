import { describe, expect, it } from "vitest";
import { IMAGE_OPTION_DEFAULTS } from "../../../src/core/config/image-options.js";
import type { Model, Row } from "../../../src/tui/model.js";
import {
  initialState,
  openImageSetup,
  reducer,
  setupOptions,
  unsavedChoices,
  type Action,
  type State,
} from "../../../src/tui/state.js";

const row = (source: string, over: Partial<Row> = {}): Row => ({
  source,
  kind: "image",
  bytes: 1000,
  width: 800,
  height: 600,
  preset: "photo",
  reason: "r",
  estimatedBytes: 100,
  savingsBytes: 900,
  plannedOutputs: 1,
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
const run = (state: State, ...actions: Action[]) => actions.reduce(reducer, state);
const scanned = (rows: Row[]): Action => ({ type: "scan-done", model: model(rows), files: [] });
const asking = () => initialState("out", undefined, undefined, { ask: true });
const key = (k: "up" | "down" | "left" | "right" | "toggle"): Action => ({
  type: "image-setup-key",
  key: k,
});

describe("image output panel", () => {
  it("opens after the first scan that finds images, and only once", () => {
    const first = run(asking(), scanned([row("a.jpg")]));
    expect(first.overlay).toBe("image-setup");
    expect(setupOptions(first.imageSetup!)).toEqual(IMAGE_OPTION_DEFAULTS);

    const again = run(first, { type: "back" }, { type: "rescan" }, scanned([row("a.jpg")]));
    expect(again.overlay).toBeNull();
  });

  it("does not open for a list of videos, or when not asked to", () => {
    expect(run(asking(), scanned([row("v.mp4", { kind: "video" })])).overlay).toBeNull();
    expect(run(initialState("out"), scanned([row("a.jpg")])).overlay).toBeNull();
  });

  it("ticks formats, keeping at least one", () => {
    let s = run(asking(), scanned([row("a.jpg")]));
    s = run(s, key("right"), key("toggle"), key("right"), key("toggle"));
    expect(s.imageSetup!.formats).toEqual(["jpg", "webp", "avif"]);
    s = run(s, key("toggle"), key("left"), key("toggle"), key("left"), key("toggle"));
    expect(s.imageSetup!.formats).toEqual(["jpg"]);
  });

  it("refuses to untick the last format", () => {
    const s = run(asking(), scanned([row("a.jpg")]), key("toggle"));
    expect(s.imageSetup!.formats).toEqual(["jpg"]);
    expect(s.status).toMatch(/at least one/);
  });

  it("chooses a max edge and a max size from the lists", () => {
    const s = run(
      asking(),
      scanned([row("a.jpg")]),
      key("down"),
      key("right"),
      key("down"),
      key("right"),
      key("right"),
    );
    expect(setupOptions(s.imageSetup!)).toEqual({
      formats: ["jpg"],
      maxEdge: 2560,
      maxSize: 300 * 1024,
    });
  });

  it("asks for a custom value that was highlighted but never typed", () => {
    const s = run(
      asking(),
      scanned([row("a.jpg")]),
      key("down"),
      key("right"),
      key("right"),
      key("right"),
    );
    expect(setupOptions(s.imageSetup!)).toBe("maxEdge");
    const typed = run(s, { type: "image-setup-custom", field: "maxEdge", value: 3000 });
    expect(setupOptions(typed.imageSetup!)).toMatchObject({ maxEdge: 3000 });
  });

  it("reopens on a custom value as custom", () => {
    const setup = openImageSetup({ formats: ["avif"], maxEdge: 3000, maxSize: 250 * 1024 });
    expect(setupOptions(setup)).toEqual({ formats: ["avif"], maxEdge: 3000, maxSize: 250 * 1024 });
    expect(setup.customEdge).toBe(3000);
    expect(setup.customSize).toBe(250 * 1024);
  });

  it("esc leaves a custom prompt first, then the panel", () => {
    let s = run(asking(), scanned([row("a.jpg")]), {
      type: "image-setup-typing",
      field: "maxSize",
    });
    s = run(s, { type: "back" });
    expect(s.overlay).toBe("image-setup");
    expect(s.imageSetup!.typing).toBeNull();
    s = run(s, { type: "back" });
    expect(s.overlay).toBeNull();
    expect(s.imageOptions).toEqual(IMAGE_OPTION_DEFAULTS);
  });

  it("offers applied options for saving, until they are written", () => {
    const options = { formats: ["webp" as const], maxEdge: 1280, maxSize: null };
    const settings = { photo: { formats: ["webp"], maxEdge: 1280 } };
    const s = run(asking(), scanned([row("a.jpg")]), {
      type: "image-setup-applied",
      options,
      settings,
    });
    expect(s.overlay).toBeNull();
    expect(unsavedChoices(s)).toEqual({ presetSettings: settings });

    const saved = run(
      s,
      { type: "save-open", choices: unsavedChoices(s) },
      { type: "save-result", outcome: { kind: "written", file: "c.json", created: true } },
    );
    expect(unsavedChoices(saved)).toEqual({});
  });
});

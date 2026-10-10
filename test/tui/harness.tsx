import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import type { ProjectInfo } from "../../src/core/scan/detect.js";
import { App } from "../../src/tui/app.js";
import type { Model, Row } from "../../src/tui/model.js";
import type { Review } from "../../src/tui/state.js";
import type { Session } from "../../src/tui/session.js";
import type { RunResult } from "../../src/core/execute/run.js";

export const KEY = {
  enter: "\r",
  esc: "\u001B",
  up: "\u001B[A",
  down: "\u001B[B",
  space: " ",
  tab: "\t",
  backspace: "\u007F",
} as const;

export const project: ProjectInfo = {
  framework: "next",
  include: ["public"],
  outDir: "public/_bytecut",
  publicPath: "/_bytecut",
  staticRoot: "public",
};

export function row(source: string, over: Partial<Row> = {}): Row {
  return {
    source,
    bytes: 100_000,
    width: 2000,
    height: 1000,
    preset: "photo",
    reason: "continuous-tone image",
    estimatedBytes: 10_000,
    savingsBytes: 90_000,
    plannedOutputs: 6,
    findings: [
      {
        ruleId: "image/no-modern-format",
        severity: "warn",
        source,
        message: "JPEG source has no outputs",
      },
    ],
    severity: "warn",
    ...over,
  };
}

export const model = (rows: Row[], over: Partial<Model> = {}): Model => ({
  rows,
  reportOnly: [],
  covered: 0,
  skipped: [],
  notes: [],
  ...over,
});

export const emptyResult: RunResult = { items: [], cancelled: false, warnings: [] };

/** A session that records calls and lets each test decide how review/run behave. */
export function fakeSession(over: Partial<Session> & { model?: Model } = {}) {
  const calls = {
    scan: 0,
    review: [] as Array<{ sources: string[]; presets: Record<string, string>; outDir: string }>,
    run: [] as Array<{ sources: string[]; presets: Record<string, string>; outDir: string }>,
  };
  const m = over.model ?? model([row("a.jpg"), row("b.jpg"), row("c.jpg", { severity: "info" })]);
  const session: Session = {
    async scan() {
      calls.scan++;
      return { model: m, files: m.rows.map((r) => r.source) };
    },
    async review(sources, presets, outDir) {
      calls.review.push({ sources, presets, outDir });
      const review: Review = {
        plan: { version: 1, outDir, publicPath: "/_bytecut", items: [] },
        items: sources.map((source) => ({
          source,
          preset: presets[source] ?? "photo",
          state: "encode" as const,
          outputs: 3,
        })),
        willEncode: sources.length,
        unchanged: 0,
        outputs: sources.length * 3,
        findings: [],
      };
      return review;
    },
    async run(sources, presets, outDir) {
      calls.run.push({ sources, presets, outDir });
      return emptyResult;
    },
    async validateOutDir() {
      return null;
    },
    ...over,
  };
  return { session, calls };
}

export function mount(session: Session, node?: (props: Parameters<typeof App>[0]) => ReactElement) {
  const props = {
    session,
    project,
    projectRoot: "/p",
    inputs: ["public"],
    outDir: "public/_bytecut",
    loadDoctor: async () => "doctor report",
  };
  const app = render(node ? node(props) : <App {...props} />);
  const frame = () => app.lastFrame() ?? "";

  async function waitFor(predicate: (frame: string) => boolean, what: string, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicate(frame())) return frame();
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame()}`);
  }

  /** Writes keys one at a time with a tick between, as a person would type. */
  async function press(...keys: string[]) {
    for (const key of keys) {
      app.stdin.write(key);
      // A lone Esc is held back by the input parser until it knows no sequence follows.
      await new Promise((r) => setTimeout(r, key === KEY.esc ? 80 : 25));
    }
  }

  async function type(text: string) {
    for (const ch of text) await press(ch);
  }

  return { ...app, frame, waitFor, press, type };
}

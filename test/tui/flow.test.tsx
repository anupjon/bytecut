import { afterEach, describe, expect, it } from "vitest";
import type { RunResult } from "../../src/core/execute/run.js";
import { emptyResult, fakeSession, KEY, model, mount, row } from "./harness.js";

let current: ReturnType<typeof mount> | undefined;
afterEach(() => current?.unmount());

async function open(session: Parameters<typeof mount>[0]) {
  current = mount(session);
  await current.waitFor((f) => f.includes("a.jpg"), "the list");
  return current;
}

describe("plan review", () => {
  it("enter plans the selected files only, with their presets, and shows the plan", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    await ui.press(KEY.space); // deselect a.jpg
    await ui.press(KEY.down, "p"); // b.jpg → hero
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Review:"), "the review");

    expect(calls.review).toEqual([
      { sources: ["b.jpg"], presets: { "b.jpg": "hero" }, outDir: "public/_bytecut" },
    ]);
    const f = ui.frame();
    expect(f).toContain("Review: 1 image → 3 outputs in public/_bytecut");
    expect(f).toMatch(/b\.jpg.*hero · 3 outputs/);
    expect(f).not.toContain("a.jpg");
    expect(f).toContain("enter to write these files");
    expect(calls.run).toEqual([]); // nothing runs until the second Enter
  });

  it("esc goes back to the list with the selection intact", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    await ui.press(KEY.space, KEY.enter);
    await ui.waitFor((f) => f.includes("Review:"), "the review");
    await ui.press(KEY.esc);
    await ui.waitFor((f) => f.includes("selected"), "the list");
    expect(ui.frame()).toMatch(/\[ \] a\.jpg/);
    expect(ui.frame()).toContain("1 of 3 files selected");
    expect(calls.run).toEqual([]);
  });

  it("enter with nothing selected explains instead of planning", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    await ui.press("a", "a", KEY.enter); // all, then none
    await ui.waitFor((f) => f.includes("Nothing selected"), "the hint");
    expect(calls.review).toEqual([]);
  });

  it("flags files already up to date and what is skipped", async () => {
    const { session } = fakeSession({
      async review(sources) {
        return {
          plan: { version: 1, outDir: "o", publicPath: "/_bytecut", items: [] },
          items: [
            { source: sources[0]!, preset: "photo", state: "encode", outputs: 2 },
            { source: "done.jpg", preset: "photo", state: "unchanged", outputs: 2 },
            {
              source: "loader.gif",
              preset: "-",
              state: "skipped",
              outputs: 0,
              note: "animated GIF",
            },
          ],
          willEncode: 1,
          unchanged: 1,
          outputs: 2,
          findings: [
            {
              ruleId: "project/stale-output",
              severity: "warn",
              source: "x.jpg",
              message: "an output file is missing",
            },
          ],
        };
      },
    });
    const ui = await open(session);
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Review:"), "the review");
    expect(ui.frame()).toContain("1 already up to date (will be skipped)");
    expect(ui.frame()).toMatch(/done\.jpg.*unchanged/);
    expect(ui.frame()).toMatch(/loader\.gif.*skipped: animated GIF/);
    expect(ui.frame()).toContain("Heads up:");
  });

  it("a planning error is shown and the list stays usable", async () => {
    const { session } = fakeSession({
      async review() {
        throw new Error("The output folder contains the project root.");
      },
    });
    const ui = await open(session);
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("contains the project root"), "the error");
    expect(ui.frame()).toMatch(/\[x\] a\.jpg/);
  });
});

describe("running", () => {
  it("second enter runs exactly the planned files and ends on a results screen", async () => {
    const { session, calls } = fakeSession({
      async run(sources, presets, outDir) {
        calls.run.push({ sources, presets, outDir });
        const result: RunResult = {
          cancelled: false,
          warnings: ["img/a-640.webp: a file is already there that bytecut did not write"],
          items: [
            {
              source: "a.jpg",
              sourceBytes: 100_000,
              sourceSha256: "0".repeat(64),
              sourceWidth: 1,
              sourceHeight: 1,
              preset: "photo",
              status: "done",
              outputs: [
                {
                  path: "a-640.avif",
                  format: "avif",
                  width: 640,
                  height: 1,
                  bytes: 20_000,
                  lossless: false,
                  quality: 60,
                  effort: 4,
                  status: "written",
                },
              ],
            },
          ],
        };
        return result;
      },
    });
    const ui = await open(session);
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Review:"), "the review");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Done"), "the results");

    expect(calls.run[0]!.sources).toEqual(["a.jpg", "b.jpg"]);
    expect(ui.frame()).toContain("1 file written");
    expect(ui.frame()).toContain("Largest size per image");
    expect(ui.frame()).toContain("warning: img/a-640.webp");
  });

  it("returning from the results rescans the project", async () => {
    const { session, calls } = fakeSession({
      async run() {
        return emptyResult;
      },
    });
    const ui = await open(session);
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Review:"), "the review");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Done"), "the results");
    expect(calls.scan).toBe(1);
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("selected"), "the list again");
    expect(calls.scan).toBe(2);
  });

  it("shows live per-output progress and the file being processed", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const { session } = fakeSession({
      async run(_s, _p, _o, handlers) {
        handlers.onItemStart("a.jpg");
        handlers.onOutput("a.jpg", {
          path: "a-640.avif",
          format: "avif",
          width: 640,
          height: 1,
          bytes: 5_000,
          lossless: false,
          quality: 60,
          effort: 4,
          status: "written",
        });
        await gate;
        return emptyResult;
      },
    });
    const ui = await open(session);
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Review:"), "the review");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("a-640.avif"), "live progress");
    expect(ui.frame()).toContain("optimizing a.jpg");
    expect(ui.frame()).toContain("0/2");
    expect(ui.frame()).toContain("esc cancel");
    finish();
    await ui.waitFor((f) => f.includes("Done"), "the results");
  });
});

describe("cancel", () => {
  it("esc aborts the run's signal, shows that it is finishing, then reports cancelled", async () => {
    let signal!: AbortSignal;
    let sawAbort = false;
    const { session } = fakeSession({
      run(_s, _p, _o, handlers, sig) {
        signal = sig;
        handlers.onItemStart("a.jpg");
        return new Promise<RunResult>((resolve) => {
          sig.addEventListener("abort", () => {
            sawAbort = true;
            // A real encode finishes before the executor notices the abort.
            setTimeout(() => resolve({ items: [], cancelled: true, warnings: [] }), 150);
          });
        });
      },
    });
    const ui = await open(session);
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Review:"), "the review");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("optimizing a.jpg"), "the run");
    expect(signal.aborted).toBe(false);

    await ui.press(KEY.esc);
    await ui.waitFor((f) => f.includes("Cancelling"), "the cancelling notice");
    expect(sawAbort).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(ui.frame()).toContain("finishing a.jpg");

    await ui.waitFor((f) => f.includes("Cancelled"), "the cancelled screen");
  });

  it("ctrl+c during a run cancels it instead of killing the process", async () => {
    let aborted = false;
    const { session } = fakeSession({
      run(_s, _p, _o, _h, sig) {
        return new Promise<RunResult>((resolve) => {
          sig.addEventListener("abort", () => {
            aborted = true;
            resolve({ items: [], cancelled: true, warnings: [] });
          });
        });
      },
    });
    const ui = await open(session);
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Review:"), "the review");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("0/2"), "the run");
    await ui.press("\u0003");
    await ui.waitFor((f) => f.includes("Cancelled"), "the cancelled screen");
    expect(aborted).toBe(true);
  });
});

describe("command bar", () => {
  async function bar() {
    const { session, calls } = fakeSession({
      model: model([
        row("public/img/gps.jpg"),
        row("public/img/photo.jpg"),
        row("public/hero/banner.jpg"),
      ]),
    });
    current = mount(session);
    await current.waitFor((f) => f.includes("gps.jpg"), "the list");
    return { ui: current, calls };
  }

  it("/ opens the palette listing every command", async () => {
    const { ui } = await bar();
    await ui.press("/");
    const f = ui.frame();
    for (const c of [
      "/audit",
      "/optimize",
      "/preset",
      "/out",
      "/select",
      "/doctor",
      "/help",
      "/quit",
    ]) {
      expect(f).toContain(c);
    }
  });

  it("filters as you type and tab completes the command", async () => {
    const { ui } = await bar();
    await ui.press("/");
    await ui.type("pre");
    expect(ui.frame()).toContain("/preset");
    expect(ui.frame()).not.toContain("/audit —");
    await ui.press(KEY.tab);
    expect(ui.frame()).toMatch(/› \/preset\s*$/m);
  });

  it("@ offers fuzzy file matches and tab completes the mention", async () => {
    const { ui } = await bar();
    await ui.press("/");
    await ui.type("preset hero @gps");
    expect(ui.frame()).toContain("@public/img/gps.jpg");
    await ui.press(KEY.tab);
    expect(ui.frame()).toContain("/preset hero @public/img/gps.jpg");
  });

  it("applies /preset to the mentioned file, not the highlighted one", async () => {
    const { ui } = await bar();
    await ui.press("/");
    await ui.type("preset icon @photo");
    await ui.press(KEY.tab, KEY.enter);
    await ui.waitFor((f) => /photo\.jpg.*icon\*/.test(f), "the override");
    expect(ui.frame()).toMatch(/gps\.jpg.*photo(?!\*)/);
  });

  it("accepts a pasted command in one chunk", async () => {
    const { ui } = await bar();
    ui.stdin.write("/select none\r");
    await ui.waitFor((f) => f.includes("0 of 3 files selected"), "the selection change");
  });

  it("/optimize @file reviews just that file", async () => {
    const { ui, calls } = await bar();
    ui.stdin.write("/optimize @banner\r");
    await ui.waitFor((f) => f.includes("Review:"), "the review");
    expect(calls.review[0]!.sources).toEqual(["public/hero/banner.jpg"]);
  });

  it("a bare @mention jumps the cursor to that file", async () => {
    const { ui } = await bar();
    ui.stdin.write("@banner\r");
    await ui.waitFor((f) => /› \[x\] public\/hero\/banner\.jpg/.test(f), "the jump");
  });

  it("explains unknown commands and esc closes the bar", async () => {
    const { ui } = await bar();
    ui.stdin.write("/bogus\r");
    await ui.waitFor((f) => f.includes("Unknown command /bogus"), "the error");
    await ui.press(KEY.esc);
    expect(ui.frame()).not.toContain("tab completes");
    expect(ui.frame()).not.toContain("Unknown command");
  });

  it("/audit rescans and /doctor shows the report", async () => {
    const { ui, calls } = await bar();
    ui.stdin.write("/audit\r");
    await ui.waitFor(() => calls.scan === 2, "a rescan");
    await ui.waitFor((f) => f.includes("gps.jpg"), "the list again");
    ui.stdin.write("/doctor\r");
    await ui.waitFor((f) => f.includes("doctor report"), "the doctor overlay");
  });

  it("backspace edits the input", async () => {
    const { ui } = await bar();
    await ui.press("/");
    await ui.type("xy");
    await ui.press(KEY.backspace, KEY.backspace);
    expect(ui.frame()).toMatch(/› \/\s*$/m);
  });
});

describe("output folder prompt", () => {
  it("o applies a valid folder and rescans", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    await ui.press("o");
    expect(ui.frame()).toContain("Output folder:");
    for (let i = 0; i < "public/_bytecut".length; i++) await ui.press(KEY.backspace);
    await ui.type("static/opt");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("→ static/opt"), "the new folder");
    await ui.waitFor(() => calls.scan === 2, "a rescan");
  });

  it("shows why a folder is refused and keeps the prompt open", async () => {
    const { session } = fakeSession({
      async validateOutDir() {
        return "Refusing to use the project root as the output folder (.).";
      },
    });
    const ui = await open(session);
    await ui.press("o");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Refusing to use the project root"), "the refusal");
    expect(ui.frame()).toContain("Output folder:");
  });
});

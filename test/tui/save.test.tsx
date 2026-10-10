import { afterEach, describe, expect, it } from "vitest";
import type { RunResult } from "../../src/core/execute/run.js";
import { emptyResult, fakeSession, KEY, mount } from "./harness.js";

let current: ReturnType<typeof mount> | undefined;
afterEach(() => current?.unmount());

async function open(session: Parameters<typeof mount>[0]) {
  current = mount(session);
  await current.waitFor((f) => f.includes("a.jpg"), "the list");
  return current;
}

/** Selects a.jpg's preset change, reviews and runs, ending on the results screen. */
async function runWithPresetChange(ui: NonNullable<typeof current>) {
  await ui.press("p"); // a.jpg: photo → hero
  await ui.press(KEY.enter);
  await ui.waitFor((f) => f.includes("Review:"), "the review");
  await ui.press(KEY.enter);
  await ui.waitFor((f) => f.includes("Done"), "the results");
}

describe("save these choices?", () => {
  it("asks after a run that used a preset the config does not hold, and saves on y", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    await runWithPresetChange(ui);
    await ui.waitFor((f) => f.includes("Save these choices to the project config?"), "the prompt");
    expect(ui.frame()).toMatch(/a\.jpg → hero/);
    expect(calls.save).toEqual([]); // asking writes nothing

    await ui.press("y");
    await ui.waitFor((f) => f.includes("Created bytecut.config.json"), "the result");
    expect(calls.save).toEqual([{ presets: { "a.jpg": "hero" } }]);

    await ui.press("x"); // any key closes
    await ui.waitFor((f) => !f.includes("Save these choices"), "the prompt to close");
    expect(ui.frame()).toContain("Done");
  });

  it("n leaves the config alone, and /save can ask again later", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    await runWithPresetChange(ui);
    await ui.waitFor((f) => f.includes("Save these choices"), "the prompt");
    await ui.press("n");
    await ui.waitFor((f) => !f.includes("Save these choices"), "the prompt to close");
    expect(calls.save).toEqual([]);

    await ui.press("s");
    await ui.waitFor((f) => f.includes("Save these choices"), "the prompt again");
    await ui.press(KEY.esc);
    await ui.waitFor((f) => !f.includes("Save these choices"), "the prompt to close");
    expect(calls.save).toEqual([]);
  });

  it("does not repeat a declined question after the next run", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    await runWithPresetChange(ui);
    await ui.waitFor((f) => f.includes("Save these choices"), "the prompt");
    await ui.press("n");
    await ui.waitFor((f) => !f.includes("Save these choices"), "the prompt to close");

    // Back to the list (rescan), run again with the same choice: no new prompt.
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("selected"), "the list");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Review:"), "the review");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Done"), "the results");
    await new Promise((r) => setTimeout(r, 150));
    expect(ui.frame()).not.toContain("Save these choices");
    expect(calls.save).toEqual([]);
  });

  it("does not ask when nothing was changed", async () => {
    const { session } = fakeSession();
    const ui = await open(session);
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Review:"), "the review");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Done"), "the results");
    await new Promise((r) => setTimeout(r, 100));
    expect(ui.frame()).not.toContain("Save these choices");
    await ui.press("s");
    await ui.waitFor((f) => f.includes("Nothing to save"), "the explanation");
  });

  it("does not ask after a cancelled run", async () => {
    const cancelled: RunResult = { ...emptyResult, cancelled: true };
    const { session } = fakeSession({ run: async () => cancelled });
    const ui = await open(session);
    await runWithPresetChange(ui).catch(() => undefined);
    await ui.waitFor((f) => f.includes("Cancelled"), "the cancelled screen");
    await new Promise((r) => setTimeout(r, 100));
    expect(ui.frame()).not.toContain("Save these choices");
  });

  it("shows what to add when the config is a file the user maintains", async () => {
    const { session } = fakeSession({
      async saveChoices() {
        return {
          kind: "manual",
          file: "bytecut.config.ts",
          snippet: 'assets: { "a.jpg": "hero" }',
        };
      },
    });
    const ui = await open(session);
    await runWithPresetChange(ui);
    await ui.waitFor((f) => f.includes("Save these choices"), "the prompt");
    await ui.press("y");
    await ui.waitFor((f) => f.includes("was not rewritten"), "the explanation");
    expect(ui.frame()).toContain('assets: { "a.jpg": "hero" }');
  });

  it("shows a failure instead of closing silently", async () => {
    const { session } = fakeSession({
      async saveChoices() {
        return { kind: "error", message: "bytecut.config.json: is not valid JSON: boom" };
      },
    });
    const ui = await open(session);
    await runWithPresetChange(ui);
    await ui.waitFor((f) => f.includes("Save these choices"), "the prompt");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("is not valid JSON: boom"), "the error");
  });
});

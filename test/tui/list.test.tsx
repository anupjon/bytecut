import { afterEach, describe, expect, it } from "vitest";
import { fakeSession, KEY, model, mount, row } from "./harness.js";

let current: ReturnType<typeof mount> | undefined;
afterEach(() => current?.unmount());

async function open(session = fakeSession().session) {
  current = mount(session);
  await current.waitFor((f) => f.includes("a.jpg"), "the list");
  return current;
}

describe("list selection", () => {
  it("shows the header, files, estimates and selection summary", async () => {
    const ui = await open();
    const f = ui.frame();
    expect(f).toContain("bytecut");
    expect(f).toContain("Next.js");
    expect(f).toContain("public/_bytecut");
    expect(f).toMatch(/\[x\] a\.jpg/);
    expect(f).toMatch(/\[x\] b\.jpg/);
    expect(f).toMatch(/\[ \] c\.jpg/); // info-level findings are not selected by default (§4)
    expect(f).toContain("2 of 3 files selected");
    expect(f).toMatch(/est\. save ~/);
    expect(f).toMatch(/97\.7 KB → ~9\.77 KB \(-90%\)/);
  });

  it("space toggles the highlighted row and the count follows", async () => {
    const ui = await open();
    await ui.press(KEY.space);
    expect(ui.frame()).toMatch(/\[ \] a\.jpg/);
    expect(ui.frame()).toContain("1 of 3 files selected");
    await ui.press(KEY.space);
    expect(ui.frame()).toMatch(/\[x\] a\.jpg/);
  });

  it("arrow keys move the cursor and space acts on the new row", async () => {
    const ui = await open();
    await ui.press(KEY.down, KEY.down, KEY.space);
    expect(ui.frame()).toMatch(/\[x\] c\.jpg/);
    expect(ui.frame()).toMatch(/› \[x\] c\.jpg/);
    expect(ui.frame()).toContain("3 of 3 files selected");
    await ui.press(KEY.up);
    expect(ui.frame()).toMatch(/› \[x\] b\.jpg/);
  });

  it("j/k also move", async () => {
    const ui = await open();
    await ui.press("j");
    expect(ui.frame()).toMatch(/› \[x\] b\.jpg/);
    await ui.press("k");
    expect(ui.frame()).toMatch(/› \[x\] a\.jpg/);
  });

  it("a selects everything, then nothing", async () => {
    const ui = await open();
    await ui.press("a");
    expect(ui.frame()).toContain("3 of 3 files selected");
    await ui.press("a");
    expect(ui.frame()).toContain("0 of 3 files selected");
  });

  it("p cycles the preset of the highlighted file and marks the override", async () => {
    const ui = await open();
    await ui.press("p");
    expect(ui.frame()).toMatch(/a\.jpg.*hero\*/);
    await ui.press("p");
    expect(ui.frame()).toMatch(/a\.jpg.*icon\*/);
    await ui.press("p");
    expect(ui.frame()).toMatch(/a\.jpg.*photo(?!\*)/);
  });

  it("d opens details for the highlighted file and esc closes them", async () => {
    const ui = await open();
    await ui.press("d");
    expect(ui.frame()).toContain("classified: continuous-tone image");
    expect(ui.frame()).toContain("image/no-modern-format");
    await ui.press(KEY.esc);
    expect(ui.frame()).not.toContain("classified:");
    expect(ui.frame()).toMatch(/› \[x\] a\.jpg/);
  });

  it("? shows help and esc closes it", async () => {
    const ui = await open();
    await ui.press("?");
    expect(ui.frame()).toContain("Commands");
    await ui.press(KEY.esc);
    expect(ui.frame()).not.toContain("Commands");
  });

  it("lists report-only findings separately and never as selectable rows", async () => {
    const { session } = fakeSession({
      model: model([row("a.jpg")], {
        reportOnly: [
          { ruleId: "svg/unminified", severity: "warn", source: "x.svg", message: "m" },
          { ruleId: "project/duplicate", severity: "warn", source: "d.png", message: "m" },
        ],
        skipped: [{ source: "loader.gif", reason: "animated GIF" }],
      }),
    });
    const ui = await open(session);
    expect(ui.frame()).toContain("Report only");
    expect(ui.frame()).toContain("svg/unminified ×1");
    expect(ui.frame()).toContain("skipped loader.gif: animated GIF");
    expect(ui.frame()).not.toMatch(/\[.\] .*x\.svg/);
  });

  it("says so when there is nothing to optimize", async () => {
    const { session } = fakeSession({ model: model([], { covered: 4 }) });
    current = mount(session);
    await current.waitFor((f) => f.includes("Nothing to optimize"), "the empty state");
    expect(current.frame()).toContain("4 already optimized");
  });

  it("windows a long list around the cursor", async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(`img/file-${String(i).padStart(2, "0")}.jpg`, { savingsBytes: 90_000 - i }),
    );
    const { session } = fakeSession({ model: model(rows) });
    current = mount(session);
    await current.waitFor((f) => f.includes("file-00"), "the list");
    expect(current.frame()).not.toContain("file-59");
    expect(current.frame()).toMatch(/↓ \d+ more/);
    for (let i = 0; i < 59; i++) await current.press(KEY.down);
    expect(current.frame()).toContain("file-59");
    expect(current.frame()).not.toContain("file-00");
    expect(current.frame()).toMatch(/↑ \d+ more/);
  });

  it("surfaces a scan failure instead of hanging", async () => {
    const { session } = fakeSession({
      async scan() {
        throw new Error("cannot read the project");
      },
    });
    current = mount(session);
    await current.waitFor((f) => f.includes("cannot read the project"), "the error");
  });
});

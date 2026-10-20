import { afterEach, describe, expect, it } from "vitest";
import { fakeSession, KEY, model, mount, row } from "./harness.js";

let current: ReturnType<typeof mount> | undefined;
afterEach(() => current?.unmount());

const RIGHT = "\u001B[C";

async function open(session: Parameters<typeof mount>[0]) {
  current = mount(session, undefined, undefined, true);
  await current.waitFor((f) => f.includes("Image output"), "the image output panel");
  return current;
}

describe("image output panel", () => {
  it("asks after the scan, with the defaults chosen", async () => {
    const { session } = fakeSession();
    const ui = await open(session);
    const frame = ui.frame();
    expect(frame).toMatch(/◉ JPEG/);
    expect(frame).toMatch(/○ WebP/);
    expect(frame).toMatch(/◉ 1920 px/);
    expect(frame).toMatch(/◉ No cap/);
    expect(frame).toContain("Custom…");
    expect(frame).not.toContain("quality search");
  });

  it("applies the chosen formats, edge and cap, then rescans", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    await ui.press(RIGHT, KEY.space, RIGHT, KEY.space); // + WebP, + AVIF
    await ui.press(KEY.down, RIGHT); // 1920 → 2560 px
    await ui.press(KEY.down, RIGHT); // 150 KB
    await ui.waitFor((f) => f.includes("quality search (target 80, floor 65)"), "the search note");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("a.jpg") && !f.includes("Image output"), "the list");
    expect(calls.imageOptions).toEqual([
      { formats: ["jpg", "webp", "avif"], maxEdge: 2560, maxSize: 150 * 1024 },
    ]);
    await ui.waitFor(() => calls.scan === 2, "a rescan");
  });

  it("takes a custom max size, and reports one it cannot read", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    await ui.press(KEY.down, KEY.down);
    for (let i = 0; i < 5; i++) await ui.press(RIGHT); // Custom…
    await ui.press(KEY.space);
    await ui.waitFor((f) => f.includes("Max size (e.g. 250 KB):"), "the custom prompt");
    await ui.type("lots");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes('"lots" is not a size'), "the error");
    for (let i = 0; i < 4; i++) await ui.press(KEY.backspace);
    await ui.type("250 KB");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Custom: 250 KB"), "the custom value");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => !f.includes("Image output"), "the panel to close");
    expect(calls.imageOptions).toEqual([{ formats: ["jpg"], maxEdge: 1920, maxSize: 250 * 1024 }]);
  });

  it("enter on an empty Custom asks for the value instead of applying", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    await ui.press(KEY.down);
    for (let i = 0; i < 4; i++) await ui.press(RIGHT);
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Max edge (px):"), "the custom prompt");
    await ui.type("3000");
    await ui.press(KEY.enter, KEY.enter);
    await ui.waitFor((f) => !f.includes("Image output"), "the panel to close");
    expect(calls.imageOptions).toEqual([{ formats: ["jpg"], maxEdge: 3000, maxSize: null }]);
  });

  it("esc keeps the current options and does not rescan", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    await ui.press(RIGHT, KEY.space, KEY.esc);
    await ui.waitFor((f) => !f.includes("Image output"), "the panel to close");
    expect(calls.imageOptions).toEqual([]);
    expect(calls.scan).toBe(1);
  });

  it("reopens with i and /images, showing what was applied", async () => {
    const { session } = fakeSession();
    const ui = await open(session);
    await ui.press(RIGHT, KEY.space, KEY.enter); // + WebP
    await ui.waitFor((f) => f.includes("a.jpg") && !f.includes("Image output"), "the list");
    await ui.press("i");
    await ui.waitFor((f) => f.includes("Image output") && /◉ WebP/.test(f), "the panel again");
    await ui.press(KEY.esc);
    await ui.waitFor((f) => !f.includes("Image output"), "the panel to close");
    await ui.press("/");
    await ui.type("images");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Image output"), "the panel via /images");
  });

  it("is not shown when there are no images to optimize", async () => {
    const { session } = fakeSession({ model: model([row("clip.mp4", { kind: "video" })]) });
    current = mount(session, undefined, undefined, true);
    await current.waitFor((f) => f.includes("clip.mp4"), "the list");
    expect(current.frame()).not.toContain("Image output");
  });

  it("offers the applied options in the save prompt", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    await ui.press(RIGHT, KEY.space, KEY.enter);
    await ui.waitFor((f) => f.includes("a.jpg") && !f.includes("Image output"), "the list");
    await ui.press("/");
    await ui.type("save");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Save these choices"), "the save prompt");
    expect(ui.frame()).toMatch(/preset photo → formats jpg, webp · maxEdge 1920/);
    await ui.press("y");
    await ui.waitFor((f) => f.includes("Created bytecut.config.json"), "the result");
    expect(calls.save).toEqual([
      { presetSettings: { photo: { formats: ["jpg", "webp"], maxEdge: 1920 } } },
    ]);
  });
});

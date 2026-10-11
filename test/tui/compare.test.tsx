import { afterEach, describe, expect, it } from "vitest";
import { fakeSession, KEY, mount } from "./harness.js";

let current: ReturnType<typeof mount> | undefined;
afterEach(() => current?.unmount());

async function open(session = fakeSession().session) {
  current = mount(session);
  await current.waitFor((f) => f.includes("a.jpg"), "the list");
  return current;
}

describe("/compare", () => {
  it("starts a local page for the mentioned file and shows its URL", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    ui.stdin.write("/compare @b.jpg\r");
    await ui.waitFor((f) => f.includes("http://127.0.0.1:4000/token/"), "the URL");
    expect(calls.compare).toEqual(["b.jpg"]);
    expect(ui.frame()).toContain("local only");
  });

  it("falls back to the highlighted file", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session);
    await ui.press(KEY.down);
    ui.stdin.write("/compare\r");
    await ui.waitFor((f) => f.includes("http://127.0.0.1"), "the URL");
    expect(calls.compare).toEqual(["b.jpg"]);
  });

  it("shows why it could not start", async () => {
    const { session } = fakeSession({
      async compare() {
        return { error: "a.jpg has not been optimized yet." };
      },
    });
    const ui = await open(session);
    ui.stdin.write("/compare @a.jpg\r");
    await ui.waitFor((f) => f.includes("has not been optimized yet"), "the error");
  });
});

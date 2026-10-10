import { afterEach, describe, expect, it } from "vitest";
import type { RunResult } from "../../src/core/execute/run.js";
import type { CopyResult } from "../../src/tui/clipboard.js";
import { fakeSession, KEY, model, mount, row } from "./harness.js";

let current: ReturnType<typeof mount> | undefined;
afterEach(() => current?.unmount());

function recordingCopy(result: CopyResult = { ok: true, method: "pbcopy" }) {
  const copied: string[] = [];
  return {
    copied,
    copy: async (text: string): Promise<CopyResult> => {
      copied.push(text);
      return result;
    },
  };
}

async function open(session = fakeSession().session, copy?: (t: string) => Promise<CopyResult>) {
  current = mount(session, undefined, copy);
  await current.waitFor((f) => f.includes("a.jpg"), "the list");
  return current;
}

describe("/snippet", () => {
  it("builds the markup for the mentioned file, shows it, and copies it", async () => {
    const { session, calls } = fakeSession();
    const { copy, copied } = recordingCopy();
    const ui = await open(session, copy);
    ui.stdin.write("/snippet @b.jpg\r");
    await ui.waitFor((f) => f.includes("Copied to the clipboard (pbcopy)"), "the snippet overlay");

    expect(calls.snippet).toEqual(["b.jpg"]);
    expect(ui.frame()).toContain("<picture>");
    expect(ui.frame()).toContain("b.jpg");
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('<img src="/_bytecut/b.jpg.webp"');
  });

  it("shows hints (e.g. missing alt text) next to the markup", async () => {
    const ui = await open(fakeSession().session, recordingCopy().copy);
    ui.stdin.write("/snippet @a.jpg\r");
    await ui.waitFor((f) => f.includes("Note: alt text is empty"), "the hint");
  });

  it("falls back to the highlighted file when none is mentioned", async () => {
    const { session, calls } = fakeSession();
    const ui = await open(session, recordingCopy().copy);
    await ui.press(KEY.down);
    ui.stdin.write("/snippet\r");
    await ui.waitFor((f) => f.includes("Copied"), "the overlay");
    expect(calls.snippet).toEqual(["b.jpg"]);
  });

  it("when the clipboard is unreachable it still shows the markup and says to select it", async () => {
    const ui = await open(fakeSession().session, recordingCopy({ ok: false }).copy);
    ui.stdin.write("/snippet @a.jpg\r");
    await ui.waitFor((f) => f.includes("Could not reach the clipboard"), "the fallback");
    expect(ui.frame()).toContain("<picture>");
    expect(ui.frame()).toContain("select the text above to copy it");
  });

  it("c copies again from the overlay, and esc closes it", async () => {
    const { copy, copied } = recordingCopy();
    const ui = await open(fakeSession().session, copy);
    ui.stdin.write("/snippet @a.jpg\r");
    await ui.waitFor((f) => f.includes("Copied"), "the overlay");
    await ui.press("c");
    await ui.waitFor(() => copied.length === 2, "a second copy");
    await ui.press(KEY.esc);
    expect(ui.frame()).not.toContain("<picture>");
    expect(ui.frame()).toMatch(/a\.jpg/);
  });

  it("explains an unoptimized file instead of showing an empty overlay", async () => {
    const { session } = fakeSession({
      async snippet(source) {
        return { error: `${source} has not been optimized yet.` };
      },
    });
    const ui = await open(session, recordingCopy().copy);
    ui.stdin.write("/snippet @a.jpg\r");
    await ui.waitFor((f) => f.includes("has not been optimized yet"), "the message");
    expect(ui.frame()).not.toContain("Copied");
  });

  it("completes files from everything scanned, not just the rows still in the list", async () => {
    const { session } = fakeSession({ model: model([row("todo.jpg")]) });
    // The scan reports one more file (already optimized, so not a row) via `files`.
    const original = session.scan.bind(session);
    session.scan = async (...args) => {
      const r = await original(...args);
      return { ...r, files: [...r.files, "done.jpg"] };
    };
    const { copy } = recordingCopy();
    current = mount(session, undefined, copy);
    await current.waitFor((f) => f.includes("todo.jpg"), "the list");
    current.stdin.write("/snippet @done\r");
    await current.waitFor((f) => f.includes("done.jpg.webp"), "the done file's snippet");
  });
});

describe("results screen", () => {
  const result: RunResult = {
    cancelled: false,
    warnings: [],
    items: ["a.jpg", "b.jpg"].map((source) => ({
      source,
      sourceBytes: 100_000,
      sourceSha256: "0".repeat(64),
      sourceWidth: 1,
      sourceHeight: 1,
      preset: "photo",
      status: "done" as const,
      outputs: [
        {
          path: `${source}-640.avif`,
          format: "avif" as const,
          width: 640,
          height: 1,
          bytes: 20_000,
          lossless: false,
          quality: 60,
          effort: 4,
          status: "written" as const,
        },
      ],
    })),
  };

  async function toResults() {
    const { session, calls } = fakeSession({
      async run() {
        return result;
      },
    });
    const { copy, copied } = recordingCopy();
    const ui = await open(session, copy);
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Review:"), "the review");
    await ui.press(KEY.enter);
    await ui.waitFor((f) => f.includes("Done"), "the results");
    return { ui, calls, copied };
  }

  it("c copies the markup for the highlighted result", async () => {
    const { ui, calls, copied } = await toResults();
    expect(ui.frame()).toContain("› a.jpg");
    expect(ui.frame()).toContain("c copy markup");
    await ui.press("c");
    await ui.waitFor((f) => f.includes("Copied to the clipboard"), "the overlay");
    expect(calls.snippet).toEqual(["a.jpg"]);
    expect(copied).toHaveLength(1);
  });

  it("↑↓ choose which result to copy", async () => {
    const { ui, calls } = await toResults();
    await ui.press(KEY.down);
    expect(ui.frame()).toContain("› b.jpg");
    await ui.press("c");
    await ui.waitFor((f) => f.includes("Copied"), "the overlay");
    expect(calls.snippet).toEqual(["b.jpg"]);
    // And the cursor does not run past the last file.
    await ui.press(KEY.esc);
    await ui.press(KEY.down, KEY.down, KEY.down);
    expect(ui.frame()).toContain("› b.jpg");
  });
});

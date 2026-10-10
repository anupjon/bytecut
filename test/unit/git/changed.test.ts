import { describe, expect, it } from "vitest";
import { changedFiles } from "../../../src/core/git/changed.js";

type Reply = string | Error;

/** A fake git keyed by the subcommand, recording every call. */
function fakeGit(replies: Record<string, Reply>) {
  const calls: string[][] = [];
  const run = async (file: string, args: string[]) => {
    expect(file).toBe("git");
    calls.push(args);
    expect(args.slice(0, 2)).toEqual(["-C", "/p"]);
    const key = args[2] === "rev-parse" ? `rev-parse ${args[3]}` : args[2]!;
    const reply = replies[key];
    if (reply === undefined) throw new Error(`unexpected git ${key}`);
    if (reply instanceof Error) throw reply;
    return { stdout: reply };
  };
  return { run, calls };
}

const ok: Record<string, Reply> = {
  "rev-parse --is-inside-work-tree": "true\n",
  "rev-parse --verify": "abc\n",
  "merge-base": "abc123\n",
  diff: "",
  "ls-files": "",
};

describe("changedFiles", () => {
  it("combines committed/staged/unstaged changes with untracked files", async () => {
    const { run } = fakeGit({
      ...ok,
      diff: "public/a.jpg\0public/img/b c.png\0",
      "ls-files": "public/new.webp\0",
    });
    const result = await changedFiles({ projectRoot: "/p", base: "origin/main", run });
    expect([...result.files].sort()).toEqual([
      "public/a.jpg",
      "public/img/b c.png",
      "public/new.webp",
    ]);
    expect(result.base).toBe("origin/main");
    expect(result.all).toBe(false);
  });

  it("measures from the merge-base and asks git for the safe, NUL-separated form", async () => {
    const { run, calls } = fakeGit(ok);
    await changedFiles({ projectRoot: "/p", base: "origin/main", run });
    const diff = calls.find((a) => a[2] === "diff")!;
    expect(diff).toEqual([
      "-C",
      "/p",
      "diff",
      "--name-only",
      "--relative",
      "--diff-filter=ACMRT",
      "-z",
      "abc123",
      "--",
      ".",
    ]);
    expect(calls.find((a) => a[2] === "merge-base")).toEqual([
      "-C",
      "/p",
      "merge-base",
      "origin/main",
      "HEAD",
    ]);
  });

  it("treats a changed bytecut config as 'everything changed'", async () => {
    for (const name of ["bytecut.config.json", "bytecut.config.ts", "bytecut.config.toml"]) {
      const { run } = fakeGit({ ...ok, diff: `${name}\0` });
      expect((await changedFiles({ projectRoot: "/p", base: "HEAD", run })).all).toBe(true);
    }
    // A config-like name in a subfolder is not the project's config.
    const { run } = fakeGit({ ...ok, diff: "docs/bytecut.config.json\0" });
    expect((await changedFiles({ projectRoot: "/p", base: "HEAD", run })).all).toBe(false);
  });

  it("reports a missing git, not a repository, and a missing ref in plain words", async () => {
    const enoent = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    await expect(
      changedFiles({
        projectRoot: "/p",
        base: "HEAD",
        run: fakeGit({ ...ok, "rev-parse --is-inside-work-tree": enoent }).run,
      }),
    ).rejects.toThrow(/needs git, which was not found/);

    await expect(
      changedFiles({
        projectRoot: "/p",
        base: "HEAD",
        run: fakeGit({
          ...ok,
          "rev-parse --is-inside-work-tree": new Error("not a git repository"),
        }).run,
      }),
    ).rejects.toThrow(/not inside one/);

    const missing = fakeGit({
      ...ok,
      "rev-parse --verify": new Error("bad ref"),
      "rev-parse --is-shallow-repository": "false\n",
    });
    await expect(
      changedFiles({ projectRoot: "/p", base: "nope", run: missing.run }),
    ).rejects.toThrow(/ref "nope" is not in this repository\. bytecut never fetches/);
  });

  it("says what to do when the clone is shallow", async () => {
    const shallow = fakeGit({
      ...ok,
      "rev-parse --verify": new Error("bad ref"),
      "rev-parse --is-shallow-repository": "true\n",
    });
    await expect(
      changedFiles({ projectRoot: "/p", base: "origin/main", run: shallow.run }),
    ).rejects.toThrow(/shallow clone.*fetch-depth: 0/);
    const noAncestor = fakeGit({ ...ok, "merge-base": new Error("none") });
    await expect(
      changedFiles({ projectRoot: "/p", base: "origin/main", run: noAncestor.run }),
    ).rejects.toThrow(/No common ancestor.*fetch-depth: 0/);
  });

  it("never passes a ref that looks like an option to git", async () => {
    const { run, calls } = fakeGit(ok);
    await expect(changedFiles({ projectRoot: "/p", base: "--output=/tmp/x", run })).rejects.toThrow(
      /not a git ref/,
    );
    expect(calls).toEqual([]);
  });
});

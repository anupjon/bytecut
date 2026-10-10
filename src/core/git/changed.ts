import { BytecutError } from "../errors.js";
import type { Run } from "../ffmpeg/index.js";
import { CONFIG_FILES } from "../config/files.js";
import { toPosix } from "../posix.js";

export interface ChangedFiles {
  /** The ref the changes are measured against, as the user wrote it. */
  base: string;
  /** Project-relative POSIX paths that differ from the base. */
  files: Set<string>;
  /**
   * Everything counts as changed: a bytecut config file differs from the base, and a new
   * budget or rule setting can change the verdict for files that did not.
   */
  all: boolean;
}

export interface ChangedOptions {
  projectRoot: string;
  base: string;
  /** Runs `git` with an argument array (§6.14). Throws when the command fails. */
  run: Run;
}

const fail = (message: string, cause?: unknown) =>
  new BytecutError("GIT_UNAVAILABLE", message, cause ? { cause } : undefined);

function nulList(stdout: string): string[] {
  return stdout.split("\0").filter((p) => p.length > 0);
}

/**
 * Files that differ from `base`: committed since the merge-base, staged, unstaged, and
 * untracked-but-not-ignored. Deleted files are left out (nothing to check). Only local git
 * data is read; nothing is fetched (§6.11).
 */
export async function changedFiles(options: ChangedOptions): Promise<ChangedFiles> {
  const { projectRoot, base, run } = options;
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await run("git", ["-C", projectRoot, ...args]);
    return stdout;
  };

  // A ref that looks like an option would be read by git as one.
  if (base.startsWith("-")) throw fail(`"${base}" is not a git ref.`);

  try {
    await git("rev-parse", "--is-inside-work-tree");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw fail(
      missing
        ? "--changed needs git, which was not found on PATH."
        : "--changed needs a git repository; this folder is not inside one.",
      error,
    );
  }

  let mergeBase: string;
  try {
    await git("rev-parse", "--verify", "--quiet", `${base}^{commit}`);
  } catch (error) {
    const shallow = (await git("rev-parse", "--is-shallow-repository").catch(() => "")).trim();
    throw fail(
      `The ref "${base}" is not in this repository.` +
        (shallow === "true"
          ? " This is a shallow clone: fetch more history first (for GitHub Actions, `fetch-depth: 0` on actions/checkout)."
          : " bytecut never fetches; fetch it yourself if it is a remote branch."),
      error,
    );
  }
  try {
    mergeBase = (await git("merge-base", base, "HEAD")).trim();
  } catch (error) {
    throw fail(
      `No common ancestor between "${base}" and HEAD. In a shallow clone, fetch more history (for GitHub Actions, \`fetch-depth: 0\`).`,
      error,
    );
  }

  // `--relative` makes paths relative to the project folder even when it is a subfolder of the
  // repository, and drops changes outside it.
  const tracked = nulList(
    await git(
      "diff",
      "--name-only",
      "--relative",
      "--diff-filter=ACMRT",
      "-z",
      mergeBase,
      "--",
      ".",
    ),
  );
  const untracked = nulList(
    await git("ls-files", "--others", "--exclude-standard", "-z", "--", "."),
  );

  const files = new Set([...tracked, ...untracked].map(toPosix));
  const configNames = new Set<string>(CONFIG_FILES);
  const all = [...files].some((f) => configNames.has(f));
  return { base, files, all };
}

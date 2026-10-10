import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { BytecutError } from "./errors.js";

/**
 * The only module that writes files (§3, §6). Sources are only ever read; every write
 * lands inside `outDir` and goes through a temp file + rename so a crash or cancel
 * can't leave a truncated output that looks valid.
 */

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** realpath of the nearest existing ancestor with the not-yet-created remainder re-appended. */
async function realpathOfExisting(path: string): Promise<string> {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      rest.push(basename(current));
      current = parent;
    }
  }
}

export interface SafeFsOptions {
  projectRoot: string;
  outDir: string;
  /** Absolute paths of the source files that will be read. */
  sourceFiles: string[];
  /** Absolute paths of directories given as sources. */
  sourceDirs: string[];
}

export class SafeFs {
  private constructor(readonly outDir: string) {}

  /** Validates `outDir` against §6.5 before anything can be written. */
  static async create(options: SafeFsOptions): Promise<SafeFs> {
    const realOut = await realpathOfExisting(options.outDir);
    const realRoot = await realpathOfExisting(options.projectRoot);

    if (realOut === realRoot) {
      throw new BytecutError(
        "UNSAFE_OUT_DIR",
        `Refusing to use the project root as the output folder (${options.outDir}).`,
      );
    }
    if (isInside(realOut, realRoot)) {
      throw new BytecutError(
        "UNSAFE_OUT_DIR",
        `The output folder ${options.outDir} contains the project root.`,
      );
    }
    for (const dir of options.sourceDirs) {
      const realDir = await realpathOfExisting(dir);
      if (realOut === realDir) {
        throw new BytecutError(
          "UNSAFE_OUT_DIR",
          `The output folder ${options.outDir} is itself a source folder.`,
        );
      }
      if (isInside(realOut, realDir)) {
        throw new BytecutError(
          "UNSAFE_OUT_DIR",
          `The output folder ${options.outDir} contains the source folder ${dir}.`,
        );
      }
    }
    for (const file of options.sourceFiles) {
      if (isInside(realOut, await realpathOfExisting(file))) {
        throw new BytecutError(
          "UNSAFE_OUT_DIR",
          `The output folder ${options.outDir} contains the source file ${file}.`,
        );
      }
    }
    return new SafeFs(realOut);
  }

  readSource(absolutePath: string): Promise<Buffer> {
    return readFile(absolutePath);
  }

  /** Validates a path relative to `outDir` and returns where it lives; touches nothing. */
  private locate(relativePosixPath: string): { target: string; dir: string } {
    const segments = relativePosixPath.split("/");
    if (
      isAbsolute(relativePosixPath) ||
      relativePosixPath.includes("\\") ||
      segments.some((s) => s === "" || s === "." || s === "..")
    ) {
      throw new BytecutError("UNSAFE_PATH", `Unsafe output path: ${relativePosixPath}`);
    }
    const target = join(this.outDir, ...segments);
    return { target, dir: dirname(target) };
  }

  /**
   * Reads a file we previously wrote (or one that sits where an output would go), or null if
   * it doesn't exist. Same path checks as writes, and never reads through a symlink.
   */
  async readOutput(relativePosixPath: string): Promise<Buffer | null> {
    const { target, dir } = this.locate(relativePosixPath);
    await this.assertInside(await realpathOfExisting(dir), relativePosixPath);
    try {
      if ((await lstat(target)).isSymbolicLink()) {
        throw new BytecutError("UNSAFE_PATH", `Refusing to read through symlink: ${target}`);
      }
      return await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** `relativePosixPath` is relative to `outDir`. */
  async writeOutput(relativePosixPath: string, data: Uint8Array): Promise<void> {
    const { target, dir } = this.locate(relativePosixPath);

    // Resolve symlinks in whatever part of the directory chain already exists *before*
    // mkdir, since `mkdir -p` would happily follow a planted symlink out of outDir.
    await this.assertInside(await realpathOfExisting(dir), relativePosixPath);
    await mkdir(dir, { recursive: true });
    await this.assertInside(await realpath(dir), relativePosixPath);

    try {
      if ((await lstat(target)).isSymbolicLink()) {
        throw new BytecutError("UNSAFE_PATH", `Refusing to write through symlink: ${target}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const temp = join(dir, `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temp, data, { flag: "wx" });
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  /**
   * A path inside `outDir` for a child process (ffmpeg) to write to. The process writes it
   * itself, so the write boundary is enforced here: the location is validated, never
   * pre-existing, and only `commitTemp` can turn it into a real output (§6.4).
   */
  async reserveTemp(relativePosixPath: string): Promise<string> {
    const { target, dir } = this.locate(relativePosixPath);
    await this.assertInside(await realpathOfExisting(dir), relativePosixPath);
    await mkdir(dir, { recursive: true });
    await this.assertInside(await realpath(dir), relativePosixPath);
    return join(dir, `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  }

  /** Atomically publishes a file made through `reserveTemp` as `relativePosixPath`. */
  async commitTemp(tempPath: string, relativePosixPath: string): Promise<void> {
    const { target, dir } = this.locate(relativePosixPath);
    if (dirname(tempPath) !== dir || !basename(tempPath).endsWith(".tmp")) {
      throw new BytecutError("UNSAFE_PATH", `Not a reserved temp file for ${relativePosixPath}`);
    }
    try {
      if ((await lstat(target)).isSymbolicLink()) {
        throw new BytecutError("UNSAFE_PATH", `Refusing to write through symlink: ${target}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(tempPath, target);
  }

  /** Removes a reserved temp file (after a failure or cancel). Never throws. */
  async discardTemp(tempPath: string): Promise<void> {
    if (!isInside(this.outDir, tempPath) || !basename(tempPath).endsWith(".tmp")) return;
    await unlink(tempPath).catch(() => undefined);
  }

  /** Absolute path of an existing output, for reading it with a streaming API. */
  async outputPath(relativePosixPath: string): Promise<string> {
    const { target, dir } = this.locate(relativePosixPath);
    await this.assertInside(await realpathOfExisting(dir), relativePosixPath);
    return target;
  }

  private async assertInside(resolved: string, requested: string): Promise<void> {
    if (!isInside(this.outDir, resolved)) {
      throw new BytecutError("UNSAFE_PATH", `Output path escapes the output folder: ${requested}`);
    }
  }
}

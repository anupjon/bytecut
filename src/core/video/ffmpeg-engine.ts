import { spawn } from "node:child_process";
import { BytecutError } from "../errors.js";
import {
  probeFfmpeg,
  resolveBinary,
  ffmpegDirOf,
  type Capabilities,
  type ResolveDeps,
  type Run,
} from "../ffmpeg/index.js";
import {
  buildClipEncodeArgs,
  buildEncodeArgs,
  buildFrameArgs,
  buildFramesArgs,
  buildPipedFramesArgs,
  buildSampleArgs,
  buildVmafArgs,
  outputWidth,
  parseVmafScore,
  progressFraction,
} from "./args.js";
import { parseProbe, type VideoProbe } from "./probe.js";
import type { RgbImage } from "../quality/types.js";
import type {
  VideoClipEncodeRequest,
  VideoEncodeRequest,
  VideoEngine,
  VideoSampleRequest,
  VideoVmafRequest,
} from "./types.js";

/** Splits tightly packed rgb24 frames; a short or ragged stream is an error, not a guess. */
function splitFrames(data: Buffer, width: number, height: number): RgbImage[] {
  const size = width * height * 3;
  if (size === 0 || data.byteLength === 0 || data.byteLength % size !== 0) {
    throw new Error("ffmpeg returned no frames, or frames of an unexpected size");
  }
  const frames: RgbImage[] = [];
  for (let at = 0; at < data.byteLength; at += size) {
    frames.push({ data: new Uint8Array(data.subarray(at, at + size)), width, height });
  }
  return frames;
}

export interface FfmpegEngineOptions {
  /** `--ffmpeg` / `--ffprobe` flag values. */
  ffmpegFlag?: string | undefined;
  ffprobeFlag?: string | undefined;
  /** `ffmpegPath` / `ffprobePath` from the config: below the flag and the env var. */
  ffmpegConfig?: string | undefined;
  ffprobeConfig?: string | undefined;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  deps: ResolveDeps;
  /** Runs short, bounded commands (`-version`, `-encoders`, `ffprobe`). */
  run: Run;
}

/** Last lines of ffmpeg's stderr, without SVT-AV1's banner, for error messages. */
function stderrTail(text: string): string {
  return text
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("Svt[info]"))
    .slice(-6)
    .join("\n");
}

interface Spawned {
  stdout: Buffer;
  code: number | null;
  stderr: string;
  aborted: boolean;
}

/**
 * Spawns with an argument array (§6.14). On abort: SIGTERM, then SIGKILL after a grace
 * period, so a cancelled encode never keeps running or holds the temp file open.
 */
function runProcess(
  file: string,
  args: string[],
  options: {
    signal?: AbortSignal | undefined;
    onStdout?: (chunk: string) => void;
    collectStdout?: boolean;
    countOnly?: boolean;
    /** Written to stdin, then closed. */
    input?: Buffer;
  } = {},
): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    // ffmpeg may close its input early (it has all it needs); that is not an error here.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
    const out: Buffer[] = [];
    let counted = 0;
    let stderr = "";
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (options.collectStdout) out.push(chunk);
      if (options.countOnly) counted += chunk.length;
      options.onStdout?.(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-16_384);
    });
    child.on("error", (error) => {
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        stdout: options.countOnly ? Buffer.alloc(counted) : Buffer.concat(out),
        code,
        stderr,
        aborted,
      });
    });
  });
}

export class AbortedError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "AbortedError";
  }
}

export function createFfmpegVideoEngine(options: FfmpegEngineOptions): VideoEngine {
  let resolved:
    | Promise<{
        ffmpeg: string;
        ffprobe: string | null;
        caps: Capabilities;
        version: string;
      } | null>
    | undefined;

  function resolve() {
    resolved ??= (async () => {
      const base = { env: options.env, platform: options.platform };
      const ffmpeg = resolveBinary(
        "ffmpeg",
        { ...base, flag: options.ffmpegFlag, config: options.ffmpegConfig },
        options.deps,
      );
      if (!ffmpeg.found) return null;
      let info;
      try {
        info = await probeFfmpeg(ffmpeg.path, options.run);
      } catch {
        return null;
      }
      const probe = resolveBinary(
        "ffprobe",
        {
          ...base,
          flag: options.ffprobeFlag,
          config: options.ffprobeConfig,
          ffmpegDir: ffmpegDirOf(ffmpeg),
        },
        options.deps,
      );
      return {
        ffmpeg: ffmpeg.path,
        ffprobe: probe.found ? probe.path : null,
        caps: info.capabilities,
        version: info.version,
      };
    })();
    return resolved;
  }

  async function need() {
    const r = await resolve();
    if (!r) throw new BytecutError("FFMPEG_NOT_FOUND", "ffmpeg was not found.");
    return r;
  }

  return {
    async capabilities() {
      return (await resolve())?.caps ?? null;
    },

    async versions() {
      const r = await resolve();
      const versions: Record<string, string> = {};
      if (r) versions.ffmpeg = r.version;
      return versions;
    },

    async probe(source): Promise<VideoProbe | null> {
      const r = await need();
      if (!r.ffprobe) {
        throw new BytecutError("FFMPEG_NOT_FOUND", "ffprobe was not found.");
      }
      const { stdout } = await options.run(r.ffprobe, [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        source,
      ]);
      return parseProbe(JSON.parse(stdout));
    },

    async encode(request: VideoEncodeRequest, onProgress, signal) {
      const r = await need();
      const result = await runProcess(r.ffmpeg, buildEncodeArgs(request), {
        signal,
        onStdout: (chunk) => {
          const f = progressFraction(chunk, request.probe.durationSec);
          if (f !== null) onProgress(f);
        },
      });
      if (result.aborted) throw new AbortedError();
      if (result.code !== 0) {
        throw new Error(`ffmpeg exited with code ${result.code}: ${stderrTail(result.stderr)}`);
      }
      onProgress(1);
    },

    async sampleBytes(request: VideoSampleRequest, signal) {
      const r = await need();
      const result = await runProcess(r.ffmpeg, buildSampleArgs(request), {
        signal,
        countOnly: true,
      });
      if (result.aborted) throw new AbortedError();
      if (result.code !== 0) {
        throw new Error(`ffmpeg exited with code ${result.code}: ${stderrTail(result.stderr)}`);
      }
      return result.stdout.byteLength;
    },

    async frames(request, signal) {
      const r = await need();
      const result = await runProcess(r.ffmpeg, buildFramesArgs(request), {
        signal,
        collectStdout: true,
      });
      if (result.aborted) throw new AbortedError();
      if (result.code !== 0) {
        throw new Error(`ffmpeg exited with code ${result.code}: ${stderrTail(result.stderr)}`);
      }
      return splitFrames(result.stdout, request.width, request.height);
    },

    async encodedFrames(request: VideoClipEncodeRequest, signal) {
      const r = await need();
      const encoded = await runProcess(r.ffmpeg, buildClipEncodeArgs(request), {
        signal,
        collectStdout: true,
      });
      if (encoded.aborted) throw new AbortedError();
      if (encoded.code !== 0) {
        throw new Error(`ffmpeg exited with code ${encoded.code}: ${stderrTail(encoded.stderr)}`);
      }
      const decoded = await runProcess(r.ffmpeg, buildPipedFramesArgs(request), {
        signal,
        collectStdout: true,
        input: encoded.stdout,
      });
      if (decoded.aborted) throw new AbortedError();
      if (decoded.code !== 0) {
        throw new Error(`ffmpeg exited with code ${decoded.code}: ${stderrTail(decoded.stderr)}`);
      }
      return splitFrames(decoded.stdout, request.width, request.height);
    },

    async vmaf(request: VideoVmafRequest, signal) {
      const r = await need();
      let candidate: Buffer | undefined;
      if (!request.candidate) {
        const encoded = await runProcess(r.ffmpeg, buildClipEncodeArgs(request), {
          signal,
          collectStdout: true,
        });
        if (encoded.aborted) throw new AbortedError();
        if (encoded.code !== 0) {
          throw new Error(`ffmpeg exited with code ${encoded.code}: ${stderrTail(encoded.stderr)}`);
        }
        candidate = encoded.stdout;
      }
      const width = outputWidth(request.probe.width, request.maxWidth);
      const height = Math.max(
        2,
        Math.round((request.probe.height * width) / Math.max(1, request.probe.width) / 2) * 2,
      );
      const scored = await runProcess(r.ffmpeg, buildVmafArgs(request, width, height), {
        signal,
        ...(candidate ? { input: candidate } : {}),
      });
      if (scored.aborted) throw new AbortedError();
      const score = parseVmafScore(scored.stderr);
      if (scored.code !== 0 || score === null) {
        throw new Error(`libvmaf did not report a score: ${stderrTail(scored.stderr)}`);
      }
      return score;
    },

    async frame(source, atSec, maxWidth) {
      const r = await need();
      const probe = await this.probe(source);
      const args = buildFrameArgs(source, atSec, maxWidth, probe?.width ?? 0);
      const result = await runProcess(r.ffmpeg, args, { collectStdout: true });
      if (result.code !== 0 || result.stdout.byteLength === 0) {
        throw new Error(`could not extract a frame: ${stderrTail(result.stderr)}`);
      }
      return result.stdout;
    },
  };
}

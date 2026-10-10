import { writeFile } from "node:fs/promises";
import type { Capabilities } from "../src/core/ffmpeg/index.js";
import { AbortedError } from "../src/core/video/ffmpeg-engine.js";
import type { VideoProbe } from "../src/core/video/probe.js";
import type {
  VideoEncodeRequest,
  VideoEngine,
  VideoSampleRequest,
} from "../src/core/video/types.js";

export const ALL_ENCODERS: Capabilities = {
  libsvtav1: true,
  libaomAv1: false,
  libx264: true,
  libvpxVp9: true,
  libvmaf: false,
};

export function probeOf(over: Partial<VideoProbe> = {}): VideoProbe {
  return {
    durationSec: 3,
    width: 1280,
    height: 720,
    fps: 30,
    videoCodec: "h264",
    pixelFormat: "yuv420p",
    bitrate: 1_000_000,
    hasAudio: true,
    audioCodec: "aac",
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    ...over,
  };
}

export interface FakeVideoOptions {
  /** `null` simulates "no ffmpeg". */
  caps?: Capabilities | null;
  /** Probe result by file basename; default for anything else. */
  probes?: Record<string, VideoProbe | null>;
  defaultProbe?: VideoProbe | null;
  /** Bytes an encode writes, by request. */
  bytes?: (request: VideoEncodeRequest) => number;
  /** Milliseconds an encode takes (abortable). */
  delayMs?: number;
  sampleBytes?: (request: VideoSampleRequest) => number;
  versions?: Record<string, string>;
}

/** A VideoEngine that records what it was asked and writes deterministic fake outputs. */
export function fakeVideoEngine(options: FakeVideoOptions = {}) {
  const calls = {
    encodes: [] as VideoEncodeRequest[],
    samples: [] as VideoSampleRequest[],
    frames: [] as Array<{ source: string; at: number }>,
    probes: [] as string[],
    aborted: 0,
  };
  const caps = options.caps === undefined ? ALL_ENCODERS : options.caps;

  const engine: VideoEngine = {
    async capabilities() {
      return caps;
    },
    async versions() {
      return caps ? { ffmpeg: "6.1.1", ...options.versions } : {};
    },
    async probe(source) {
      calls.probes.push(source);
      const name = source.split("/").pop()!;
      if (options.probes && name in options.probes) return options.probes[name] ?? null;
      return options.defaultProbe === undefined ? probeOf() : options.defaultProbe;
    },
    async encode(request, onProgress, signal) {
      calls.encodes.push(request);
      onProgress(0.25);
      if (options.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              calls.aborted++;
              reject(new AbortedError());
            },
            { once: true },
          );
          if (signal.aborted) {
            clearTimeout(timer);
            calls.aborted++;
            reject(new AbortedError());
          }
        });
      }
      const size = options.bytes?.(request) ?? 1000;
      // Content depends on the request so identical requests give identical files.
      const body = Buffer.alloc(size, (request.crf + request.encoder.length) % 251);
      await writeFile(request.output, body);
      onProgress(1);
    },
    async sampleBytes(request) {
      calls.samples.push(request);
      return options.sampleBytes?.(request) ?? Math.round(request.durationSec * 10_000);
    },
    async frame(source, atSec) {
      calls.frames.push({ source, at: atSec });
      return Buffer.from("PNGDATA");
    },
  };
  return { engine, calls };
}

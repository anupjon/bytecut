import type { Capabilities } from "../ffmpeg/index.js";
import type { RgbImage } from "../quality/types.js";
import type { VideoProbe } from "./probe.js";

export type VideoCodec = "av1" | "h264";

/** The concrete encoder chosen for a codec on this machine. */
export type EncoderName = "libsvtav1" | "libaom-av1" | "libx264";

export interface VideoEncodeRequest {
  /** Absolute, read-only. */
  source: string;
  /** Absolute path reserved through SafeFs; the only file ffmpeg is allowed to write. */
  output: string;
  encoder: EncoderName;
  /** Constant rate factor for the chosen encoder. */
  crf: number;
  /** SVT-AV1 `-preset` number, libaom `-cpu-used`, or an x264 preset name. */
  speed: string;
  maxWidth: number | null;
  maxFps: number | null;
  audio: "strip" | "keep";
  audioBitrate: string;
  probe: VideoProbe;
}

export interface VideoSampleRequest {
  source: string;
  encoder: EncoderName;
  crf: number;
  speed: string;
  maxWidth: number | null;
  maxFps: number | null;
  startSec: number;
  durationSec: number;
  probe: VideoProbe;
}

/** A short window of a video, scored at a fixed geometry so two renderings line up. */
export interface VideoClip {
  startSec: number;
  durationSec: number;
}

export interface VideoFramesRequest extends VideoClip {
  /** What to read: the source, or an already-encoded output. */
  source: string;
  /** Evenly spaced frames to return. */
  count: number;
  /** Every frame is scaled to exactly this size (even numbers). */
  width: number;
  height: number;
  /**
   * Set for the source: apply the output's frame-rate cap and scale first, so the reference is
   * what the encoder was given. Null for an output, which already has that shape.
   */
  pipeline: { probe: VideoProbe; maxWidth: number | null; maxFps: number | null } | null;
}

export interface VideoVmafRequest extends VideoSampleRequest {
  /** An already-encoded file to judge instead of encoding the clip at `crf`. */
  candidate?: string;
}

/** Encode one clip and decode what came out: quality of a candidate CRF without writing a file. */
export interface VideoClipEncodeRequest extends VideoSampleRequest {
  count: number;
  width: number;
  height: number;
}

/**
 * Behind an interface so the executor and audit can be tested with a fake (§3), and so a
 * missing ffmpeg is an ordinary, handled state instead of an exception at every call site.
 */
export interface VideoEngine {
  /** Null when no usable ffmpeg was found. */
  capabilities(): Promise<Capabilities | null>;
  /** Installed encoder versions for the manifest, e.g. `{ libsvtav1: "1.7.0" }`; may be empty. */
  versions(): Promise<Record<string, string>>;
  probe(source: string): Promise<VideoProbe | null>;
  /** Writes `request.output`. Resolves on success; rejects on failure or cancellation. */
  encode(
    request: VideoEncodeRequest,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Encoded size in bytes of a short clip, without writing any file. */
  sampleBytes(request: VideoSampleRequest, signal?: AbortSignal): Promise<number>;
  /** Decoded RGB frames of a clip. Reads only; nothing is written. */
  frames(request: VideoFramesRequest, signal?: AbortSignal): Promise<RgbImage[]>;
  /** The frames of `request`'s clip after encoding it at `request.crf`, in memory. */
  encodedFrames(request: VideoClipEncodeRequest, signal?: AbortSignal): Promise<RgbImage[]>;
  /**
   * libvmaf's pooled mean for the clip encoded at `request.crf` against the source, at the
   * output's resolution. Needs `capabilities().libvmaf`.
   */
  vmaf(request: VideoVmafRequest, signal?: AbortSignal): Promise<number>;
  /** One decoded frame as PNG, for the poster. */
  frame(source: string, atSec: number, maxWidth: number | null): Promise<Buffer>;
}

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ImageEngine } from "../engines/types.js";
import { pickAv1Encoder } from "../ffmpeg/index.js";
import { sha256, sha256File } from "../hash.js";
import { checkVideoCache } from "../manifest/cache.js";
import type { Manifest, ManifestVideoOutput } from "../manifest/types.js";
import type {
  PlannedMediaOutput,
  PlannedPosterOutput,
  PlannedVideoOutput,
  VideoPlanItem,
} from "../plan/types.js";
import { readVideoCodecString } from "../video/codecs.js";
import { AbortedError } from "../video/ffmpeg-engine.js";
import type { VideoProbe } from "../video/probe.js";
import type { EncoderName, VideoEngine } from "../video/types.js";
import {
  CONFIRM_STEP,
  CRF_RANGE,
  MAX_CONFIRM_BUMPS,
  createVideoSearcher,
  scoreGeometry,
  type VideoSearcher,
} from "../quality/video-search.js";
import type { QualityScorer } from "../quality/types.js";
import type { OutputStatus, VideoItemResult, VideoOutputResult } from "./run.js";

export interface VideoLaneFs {
  readOutput(relativePosixPath: string): Promise<Buffer | null>;
  writeOutput(relativePosixPath: string, data: Uint8Array): Promise<void>;
  outputPath(relativePosixPath: string): Promise<string>;
  reserveTemp(relativePosixPath: string): Promise<string>;
  commitTemp(tempPath: string, relativePosixPath: string): Promise<void>;
  discardTemp(tempPath: string): Promise<void>;
}

export interface VideoRunContext {
  projectRoot: string;
  engine: VideoEngine;
  imageEngine: ImageEngine;
  fs: VideoLaneFs;
  manifest: Manifest | null;
  force: boolean;
  signal: AbortSignal | undefined;
  /** path → sha256 of every file the manifest says bytecut wrote. */
  owned: Map<string, string>;
  warnings: Set<string>;
  /** Perceptual search. Absent: searched outputs use their fixed CRF, with a warning. */
  quality?: { scorer(): Promise<QualityScorer> } | undefined;
  onProgress?: ((source: string, path: string, fraction: number) => void) | undefined;
  onOutputDone?: ((source: string, output: VideoOutputResult) => void) | undefined;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function encoderFor(
  codec: "av1" | "h264",
  caps: { libsvtav1: boolean; libaomAv1: boolean; libx264: boolean },
): EncoderName | null {
  if (codec === "h264") return caps.libx264 ? "libx264" : null;
  return pickAv1Encoder({ ...caps, libvpxVp9: false, libvmaf: false });
}

function probeFromItem(item: VideoPlanItem): VideoProbe {
  return {
    durationSec: item.durationSec,
    width: item.sourceWidth,
    height: item.sourceHeight,
    fps: item.fps,
    videoCodec: item.videoCodec,
    pixelFormat: null,
    bitrate: null,
    hasAudio: item.hasAudio,
    audioCodec: null,
    container: "unknown",
  };
}

const evenHeight = (probe: VideoProbe, width: number) =>
  Math.max(2, Math.round((probe.height * width) / Math.max(1, probe.width) / 2) * 2);

function sameParams(planned: PlannedMediaOutput, r: ManifestVideoOutput): boolean {
  if (planned.role !== r.role || planned.width !== r.width) return false;
  if (planned.role === "video") {
    const search = planned.search;
    const sameSearch =
      search === undefined
        ? r.search === undefined && r.crf === planned.crf
        : r.search?.metric === search.metric && r.search.target === search.target;
    return (
      sameSearch &&
      r.codec === planned.codec &&
      r.speed === planned.speed &&
      r.maxWidth === planned.maxWidth &&
      r.maxFps === planned.maxFps &&
      r.audio === planned.audio
    );
  }
  return r.quality === planned.quality && r.effort === planned.effort && r.at === planned.at;
}

export async function runVideoItem(
  item: VideoPlanItem,
  ctx: VideoRunContext,
): Promise<VideoItemResult> {
  const base = {
    source: item.source,
    sourceBytes: item.sourceBytes,
    sourceSha256: item.sourceSha256,
    sourceWidth: item.sourceWidth,
    sourceHeight: item.sourceHeight,
    durationSec: item.durationSec,
    preset: item.preset,
  };
  if (item.skip) return { ...base, status: "skipped", reason: item.skip.reason, outputs: [] };

  const caps = await ctx.engine.capabilities();
  if (!caps) {
    return { ...base, status: "skipped", reason: "needs ffmpeg", outputs: [] };
  }

  const sourcePath = resolve(ctx.projectRoot, ...item.source.split("/"));
  let digest: string;
  try {
    digest = await sha256File(sourcePath);
  } catch (error) {
    return { ...base, status: "failed", reason: message(error), outputs: [] };
  }
  // A saved plan must never be applied to different bytes.
  if (digest !== item.sourceSha256) {
    return {
      ...base,
      status: "failed",
      reason: "source changed since the plan was created; re-run to build a fresh plan",
      outputs: [],
    };
  }

  const hashOutput = async (path: string): Promise<string | null> => {
    try {
      return await sha256File(await ctx.fs.outputPath(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  const unavailable = new Set<string>();
  for (const codec of ["av1", "h264"] as const) {
    if (!encoderFor(codec, caps)) unavailable.add(codec);
  }

  const entry = ctx.manifest?.videos[item.source];
  const recorded = new Map((entry?.outputs ?? []).map((o) => [o.path, o]));
  const sameSource = entry?.sha256 === item.sourceSha256;

  const probe = probeFromItem(item);
  const versions = await ctx.engine.versions();
  const encoderLabel = (name: string) => `${name} (ffmpeg ${versions.ffmpeg ?? "unknown"})`;

  const outputs: VideoOutputResult[] = [];
  const record = (output: VideoOutputResult) => {
    outputs.push(output);
    ctx.onOutputDone?.(item.source, output);
  };
  let encodedAny = false;
  let failed = false;

  // An output made with a fixed CRF because its metric was unavailable is worth redoing once
  // the metric is: it carries `search` but no `score`.
  const searchable = (metric: "ssimulacra2" | "vmaf") =>
    metric === "vmaf" ? caps.libvmaf : ctx.quality !== undefined;
  const retrySearch = new Set<string>();
  for (const r of entry?.outputs ?? []) {
    if (r.search && r.score === undefined && searchable(r.search.metric)) retrySearch.add(r.path);
  }

  // Fast path: everything that can exist already does, with matching hashes.
  const noForce = !ctx.force;
  if (noForce && retrySearch.size === 0) {
    const state = await checkVideoCache(item, entry, hashOutput, unavailable);
    if (state.kind === "hit") {
      for (const planned of item.outputs) {
        const r = recorded.get(planned.path);
        if (!r) {
          // An output whose encoder is unavailable: report it, don't pretend.
          if (planned.role === "video") {
            record(unavailableResult(planned, ctx));
          }
          continue;
        }
        record(fromRecorded(r));
      }
      return { ...base, status: "cached", outputs };
    }
  }

  for (const planned of item.outputs) {
    if (ctx.signal?.aborted) {
      record(blank(planned, "cancelled"));
      continue;
    }

    // Per-output reuse: an expensive encode that is already valid is never repeated, which is
    // what makes resuming a cancelled run cheap.
    const prior = recorded.get(planned.path);
    if (
      noForce &&
      sameSource &&
      prior &&
      prior.status === "written" &&
      !retrySearch.has(planned.path) &&
      sameParams(planned, prior)
    ) {
      const actual = await hashOutput(planned.path);
      if (actual !== null && actual === prior.sha256) {
        record(fromRecorded(prior));
        continue;
      }
    }

    try {
      if (planned.role === "poster") {
        const result = await makePoster(planned, sourcePath, probe, ctx, encoderLabel);
        record(result.output);
        if (result.wrote) encodedAny = true;
        continue;
      }

      const encoder = encoderFor(planned.codec, caps);
      if (!encoder) {
        record(unavailableResult(planned, ctx));
        continue;
      }
      const result = await makeVideo(
        planned,
        item,
        sourcePath,
        probe,
        encoder,
        caps.libvmaf,
        ctx,
        encoderLabel,
      );
      record(result.output);
      if (result.wrote) encodedAny = true;
      if (result.output.status === "failed" || result.output.status === "unmet") failed = true;
    } catch (error) {
      if (error instanceof AbortedError || ctx.signal?.aborted) {
        record(blank(planned, "cancelled"));
      } else {
        failed = true;
        record({ ...blank(planned, "failed"), error: message(error) });
      }
    }
  }

  const cancelled = outputs.some((o) => o.status === "cancelled");
  const allReused = !encodedAny && !failed && !cancelled;
  return {
    ...base,
    status: failed ? "failed" : cancelled ? "cancelled" : allReused ? "cached" : "done",
    outputs,
  };
}

function unavailableResult(planned: PlannedVideoOutput, ctx: VideoRunContext): VideoOutputResult {
  const encoders = planned.codec === "av1" ? "libsvtav1 or libaom-av1" : "libx264";
  ctx.warnings.add(
    `${planned.codec === "av1" ? "AV1" : "H.264"} encoder not available (needs ${encoders}): ${planned.codec === "av1" ? "AV1" : "H.264"} outputs were skipped`,
  );
  return { ...blank(planned, "unavailable"), codec: planned.codec };
}

function blank(planned: PlannedMediaOutput, status: OutputStatus): VideoOutputResult {
  return {
    path: planned.path,
    role: planned.role,
    format: planned.role === "video" ? "mp4" : "avif",
    ...(planned.role === "video" ? { codec: planned.codec } : {}),
    width: planned.width,
    height: 0,
    bytes: 0,
    status,
  };
}

function fromRecorded(r: ManifestVideoOutput): VideoOutputResult {
  return {
    path: r.path,
    role: r.role,
    format: r.format,
    ...(r.codec ? { codec: r.codec } : {}),
    width: r.width,
    height: r.height,
    ...(r.fps !== undefined ? { fps: r.fps } : {}),
    bytes: r.bytes,
    ...(r.sha256 ? { sha256: r.sha256 } : {}),
    ...(r.crf !== undefined ? { crf: r.crf } : {}),
    ...(r.speed !== undefined ? { speed: r.speed } : {}),
    ...(r.maxWidth !== undefined ? { maxWidth: r.maxWidth } : {}),
    ...(r.maxFps !== undefined ? { maxFps: r.maxFps } : {}),
    ...(r.audio !== undefined ? { audio: r.audio } : {}),
    ...(r.quality !== undefined ? { quality: r.quality } : {}),
    ...(r.effort !== undefined ? { effort: r.effort } : {}),
    ...(r.at !== undefined ? { at: r.at } : {}),
    ...(r.codecs ? { codecs: r.codecs } : {}),
    ...(r.search ? { search: r.search } : {}),
    ...(r.score !== undefined ? { score: r.score } : {}),
    ...(r.scorer ? { scorer: r.scorer } : {}),
    encoder: r.encoder,
    status: r.status === "already-optimal" ? "already-optimal" : "unchanged",
  };
}

/** Existing-file policy shared by videos and posters (§6.6). Returns null to proceed. */
async function existingPolicy(
  path: string,
  newHash: string,
  ctx: VideoRunContext,
): Promise<"unchanged" | "protected" | null> {
  let existing: string | null = null;
  try {
    existing = await sha256File(await ctx.fs.outputPath(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing === null) return null;
  if (existing === newHash) return "unchanged";
  if (!ctx.force && ctx.owned.get(path) !== existing) {
    ctx.warnings.add(
      `${path}: a file is already there that bytecut did not write or that was edited; left alone (use --force to overwrite)`,
    );
    return "protected";
  }
  return null;
}

type Searched =
  /** No search planned, or it could not run: encode at the planned CRF. */
  | { kind: "fixed"; skipped: boolean }
  | {
      kind: "found";
      crf: number;
      score: number;
      scorer: "wasm" | "native" | "libvmaf";
      searcher: VideoSearcher;
    }
  | { kind: "unmet"; reason: string };

/** Share of a video output's progress bar that the CRF search takes. */
const SEARCH_SHARE = 0.4;
const EXPECTED_PROBES = 7;

async function searchCrf(
  planned: PlannedVideoOutput,
  item: VideoPlanItem,
  sourcePath: string,
  probe: VideoProbe,
  encoder: EncoderName,
  hasLibvmaf: boolean,
  ctx: VideoRunContext,
): Promise<Searched> {
  const search = planned.search;
  if (!search) return { kind: "fixed", skipped: false };
  const skip = (why: string): Searched => {
    ctx.warnings.add(`${planned.path}: ${why}; used the fixed CRF ${planned.crf}`);
    return { kind: "fixed", skipped: true };
  };

  let scorer: QualityScorer | undefined;
  if (search.metric === "vmaf") {
    if (!hasLibvmaf) return skip("libvmaf is missing, so the VMAF search was skipped");
  } else {
    if (!ctx.quality) return skip("no quality scorer is available, so the search was skipped");
    try {
      scorer = await ctx.quality.scorer();
    } catch (error) {
      return skip(`the quality scorer could not start (${message(error)})`);
    }
  }
  const { width, height } = scoreGeometry(probe, planned.maxWidth);
  if (search.metric === "ssimulacra2" && (width < 8 || height < 8)) {
    return skip("the video is too small to score");
  }

  const searcher = createVideoSearcher({
    engine: ctx.engine,
    metric: search.metric,
    target: search.target,
    scorer,
    source: sourcePath,
    probe,
    codec: planned.codec,
    encoder,
    speed: planned.speed,
    maxWidth: planned.maxWidth,
    maxFps: planned.maxFps,
    startCrf: planned.crf,
    signal: ctx.signal,
    onProbe: () => {
      probes++;
      ctx.onProgress?.(
        item.source,
        planned.path,
        SEARCH_SHARE * Math.min(1, probes / EXPECTED_PROBES),
      );
    },
  });
  let probes = 0;
  const outcome = await searcher.find();
  if (!outcome.ok) {
    return {
      kind: "unmet",
      reason: `${search.metric} reached only ${outcome.bestScore.toFixed(1)} at crf ${CRF_RANGE[planned.codec].lo}, below the target ${search.target}`,
    };
  }
  return {
    kind: "found",
    crf: outcome.crf,
    score: outcome.score,
    scorer: search.metric === "vmaf" ? "libvmaf" : scorer!.kind,
    searcher,
  };
}

async function makeVideo(
  planned: PlannedVideoOutput,
  item: VideoPlanItem,
  sourcePath: string,
  probe: VideoProbe,
  encoder: EncoderName,
  hasLibvmaf: boolean,
  ctx: VideoRunContext,
  encoderLabel: (name: string) => string,
): Promise<{ output: VideoOutputResult; wrote: boolean }> {
  const searched = await searchCrf(planned, item, sourcePath, probe, encoder, hasLibvmaf, ctx);
  if (searched.kind === "unmet") {
    ctx.warnings.add(`${planned.path}: ${searched.reason}; nothing was written`);
    return {
      output: {
        ...blank(planned, "unmet"),
        codec: planned.codec,
        error: searched.reason,
      },
      wrote: false,
    };
  }
  const found = searched.kind === "found" ? searched : null;
  const range = CRF_RANGE[planned.codec];
  let crf = found ? found.crf : planned.crf;
  let score = found?.score;
  const base = found ? SEARCH_SHARE : 0;

  const temp = await ctx.fs.reserveTemp(planned.path);
  try {
    for (let bumps = 0; ; bumps++) {
      await ctx.engine.encode(
        {
          source: sourcePath,
          output: temp,
          encoder,
          crf,
          speed: planned.speed,
          maxWidth: planned.maxWidth,
          maxFps: planned.maxFps,
          audio: planned.audio,
          audioBitrate: planned.audioBitrate,
          probe,
        },
        (fraction) => ctx.onProgress?.(item.source, planned.path, base + (1 - base) * fraction),
        ctx.signal ?? new AbortController().signal,
      );
      // A whole-video search measured exactly this encode; a sampled one is checked on the
      // real output, because rate control over the full length can differ from a clip's.
      if (!found || found.searcher.whole) break;
      const measured = await found.searcher.confirm(temp, crf);
      if (measured >= planned.search!.target) {
        score = measured;
        break;
      }
      if (bumps >= MAX_CONFIRM_BUMPS || crf - CONFIRM_STEP < range.lo) {
        await ctx.fs.discardTemp(temp);
        const reason = `${planned.search!.metric} was ${measured.toFixed(1)} on the full encode at crf ${crf}, below the target ${planned.search!.target}`;
        ctx.warnings.add(`${planned.path}: ${reason}; nothing was written`);
        return {
          output: { ...blank(planned, "unmet"), codec: planned.codec, error: reason },
          wrote: false,
        };
      }
      crf -= CONFIRM_STEP;
    }

    const { size } = await stat(temp);
    // Exact codec string from the file itself, plus AAC-LC when audio was kept.
    const video = await readVideoCodecString(temp).catch(() => null);
    const codecs = video
      ? planned.audio === "keep" && probe.hasAudio
        ? `${video}, mp4a.40.2`
        : video
      : undefined;
    const fps = planned.maxFps !== null ? Math.min(probe.fps, planned.maxFps) : probe.fps;
    const result: VideoOutputResult = {
      path: planned.path,
      role: "video",
      format: "mp4",
      codec: planned.codec,
      width: planned.width,
      height: evenHeight(probe, planned.width),
      fps: Math.round(fps * 100) / 100,
      bytes: size,
      crf,
      speed: planned.speed,
      maxWidth: planned.maxWidth,
      maxFps: planned.maxFps,
      audio: planned.audio,
      ...(codecs ? { codecs } : {}),
      // Recorded even when the search could not run, so the cache recognises the output; a
      // missing score is what marks it as worth searching once the metric is available.
      ...(planned.search ? { search: planned.search } : {}),
      ...(score !== undefined && found
        ? { score: Math.round(score * 100) / 100, scorer: found.scorer }
        : {}),
      encoder: encoderLabel(encoder),
      status: "written",
    };

    // §6.7: never emit a file larger than the best existing equivalent.
    if (size >= item.sourceBytes) {
      await ctx.fs.discardTemp(temp);
      return { output: { ...result, status: "already-optimal" }, wrote: true };
    }

    const digest = await sha256File(temp);
    const verdict = await existingPolicy(planned.path, digest, ctx);
    if (verdict) {
      await ctx.fs.discardTemp(temp);
      return { output: { ...result, sha256: digest, status: verdict }, wrote: false };
    }
    await ctx.fs.commitTemp(temp, planned.path);
    return { output: { ...result, sha256: digest }, wrote: true };
  } catch (error) {
    await ctx.fs.discardTemp(temp);
    throw error;
  }
}

async function makePoster(
  planned: PlannedPosterOutput,
  sourcePath: string,
  probe: VideoProbe,
  ctx: VideoRunContext,
  encoderLabel: (name: string) => string,
): Promise<{ output: VideoOutputResult; wrote: boolean }> {
  // A frame early in the clip: the first frame is often black.
  const at = Math.max(0, probe.durationSec * planned.at);
  const png = await ctx.engine.frame(sourcePath, at, planned.width);
  const encoded = await ctx.imageEngine.encode(png, {
    format: "avif",
    width: planned.width,
    lossless: false,
    quality: planned.quality,
    effort: planned.effort,
  });
  const digest = sha256(encoded.data);
  const output: VideoOutputResult = {
    path: planned.path,
    role: "poster",
    format: "avif",
    width: encoded.width,
    height: encoded.height,
    bytes: encoded.data.byteLength,
    sha256: digest,
    quality: planned.quality,
    effort: planned.effort,
    at: planned.at,
    encoder: encoded.encoder || encoderLabel("poster"),
    status: "written",
  };
  const verdict = await existingPolicy(planned.path, digest, ctx);
  if (verdict) return { output: { ...output, status: verdict }, wrote: false };
  await ctx.fs.writeOutput(planned.path, encoded.data);
  return { output, wrote: true };
}

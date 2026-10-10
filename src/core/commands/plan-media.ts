import { resolve } from "node:path";
import type { AnalysisCache } from "../cache/store.js";
import { ANIMATED_GIF_REASON } from "../plan/build.js";
import type { Plan } from "../plan/types.js";
import type { PresetPolicy } from "../presets/catalog.js";
import { buildVideoItems } from "../plan/video.js";
import type { VideoEngine } from "../video/types.js";

/**
 * Takes an image plan and adds the video side: animated GIFs are lifted out of the image
 * items (they are re-encoded as video) and planned together with the video files found.
 * Shared by `optimize` and `audit` so both agree on what a project's media is.
 */
export async function withVideos(
  plan: Plan,
  options: {
    projectRoot: string;
    staticRoot: string;
    /** Absolute paths of video files found by the scanner. */
    videoFiles: string[];
    videoEngine: VideoEngine | null;
    needsFfmpeg: string;
    presetOverrides?: Record<string, string> | undefined;
    policy?: PresetPolicy | undefined;
    cache: AnalysisCache;
  },
): Promise<Plan> {
  const gifSources = new Set(
    plan.items.filter((i) => i.skip?.reason.startsWith(ANIMATED_GIF_REASON)).map((i) => i.source),
  );
  const files = [
    ...options.videoFiles,
    ...[...gifSources].map((s) => resolve(options.projectRoot, ...s.split("/"))),
  ];
  const images = { ...plan, items: plan.items.filter((i) => !gifSources.has(i.source)) };
  if (files.length === 0) return images;

  const claimed = new Set(images.items.flatMap((i) => i.outputs.map((o) => o.path)));
  const engine = options.videoEngine;
  const videos = await buildVideoItems({
    files,
    projectRoot: options.projectRoot,
    staticRoot: options.staticRoot,
    engine,
    needsFfmpeg: options.needsFfmpeg,
    ...(options.presetOverrides ? { presetOverrides: options.presetOverrides } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
    claimed,
    async probe(path, digest) {
      const cached = options.cache.getVideoProbe(digest);
      if (cached) return cached;
      const fresh = engine ? await engine.probe(path) : null;
      if (fresh) options.cache.setVideoProbe(digest, fresh);
      return fresh;
    },
  });
  return videos.length > 0 ? { ...images, videos } : images;
}

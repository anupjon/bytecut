import type { VideoPresetName } from "../presets/video.js";
import type { VideoProbe } from "../video/probe.js";

export interface VideoClassification {
  preset: VideoPresetName;
  confidence: "high" | "medium" | "low";
  reason: string;
}

const BACKGROUND_NAME =
  /(^|[^a-z])(bg|background|backdrop|loop|ambient|hero|banner|header|splash|texture|cover)([^a-z]|$)/i;
/** Backdrops are short; a long clip with such a name is more likely real content. */
export const BACKGROUND_MAX_SECONDS = 45;

function baseName(source: string): string {
  const name = source.slice(source.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Silent audio is the one thing background-video does that cannot be undone, so it is only
 * chosen on evidence: no audio at all, or a backdrop-looking name on a short clip. Anything
 * else keeps its audio and resolution (§6.8).
 */
export function classifyVideo(source: string, probe: VideoProbe): VideoClassification {
  const name = baseName(source);
  const named = BACKGROUND_NAME.test(name);
  const short = probe.durationSec > 0 && probe.durationSec <= BACKGROUND_MAX_SECONDS;

  if (!probe.hasAudio && short) {
    return {
      preset: "background-video",
      confidence: named ? "high" : "medium",
      reason: `silent ${probe.durationSec.toFixed(0)}s clip${named ? `, name "${name}"` : ""}`,
    };
  }
  if (named && short && probe.hasAudio) {
    return {
      preset: "background-video",
      confidence: "medium",
      reason: `name "${name}" and ${probe.durationSec.toFixed(0)}s long; its audio track will be removed`,
    };
  }
  return {
    preset: "content-video",
    confidence: probe.hasAudio ? "high" : "low",
    reason: probe.hasAudio
      ? "has an audio track, so it is treated as content"
      : "long silent video; keeping resolution and frame rate",
  };
}

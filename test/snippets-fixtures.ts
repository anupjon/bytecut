import type {
  Manifest,
  ManifestOutput,
  ManifestSource,
  ManifestVideoOutput,
  ManifestVideoSource,
} from "../src/core/manifest/types.js";

const H = "a".repeat(64);

export const image = (
  path: string,
  format: "avif" | "webp",
  width: number,
  height: number,
  over: Partial<ManifestOutput> = {},
): ManifestOutput => ({
  path,
  url: `/_bytecut/${path}`,
  format,
  width,
  height,
  bytes: width * 10,
  sha256: H,
  lossless: false,
  quality: 60,
  effort: 4,
  encoder: "libaom-av1 3.15.1",
  status: "written",
  ...over,
});

export function photoEntry(over: Partial<ManifestSource> = {}): ManifestSource {
  return {
    sha256: H,
    bytes: 100_000,
    width: 1400,
    height: 900,
    preset: "photo",
    placeholder: { kind: "dominant-color", value: "#d828c8" },
    outputs: [
      image("img/photo/photo-640.avif", "avif", 640, 411),
      image("img/photo/photo-1280.avif", "avif", 1280, 823),
      image("img/photo/photo-1400.avif", "avif", 1400, 900),
      image("img/photo/photo-640.webp", "webp", 640, 411),
      image("img/photo/photo-1280.webp", "webp", 1280, 823),
      image("img/photo/photo-1400.webp", "webp", 1400, 900),
    ],
    ...over,
  };
}

export function heroEntry(): ManifestSource {
  return {
    sha256: H,
    bytes: 400_000,
    width: 2600,
    height: 1400,
    preset: "hero",
    priority: true,
    placeholder: { kind: "dominant-color", value: "#2828c8" },
    outputs: [
      image("img/hero/hero-1280.avif", "avif", 1280, 689),
      image("img/hero/hero-2560.avif", "avif", 2560, 1378),
      image("img/hero/hero-1280.webp", "webp", 1280, 689),
      image("img/hero/hero-2560.webp", "webp", 2560, 1378),
    ],
  };
}

const video = (
  path: string,
  codec: "av1" | "h264",
  codecs: string | undefined,
  over: Partial<ManifestVideoOutput> = {},
): ManifestVideoOutput => ({
  path,
  url: `/_bytecut/${path}`,
  role: "video",
  format: "mp4",
  codec,
  width: 1280,
  height: 720,
  bytes: 5000,
  sha256: H,
  ...(codecs ? { codecs } : {}),
  encoder: "ffmpeg 6.1.1",
  status: "written",
  ...over,
});

const poster = (path: string): ManifestVideoOutput => ({
  path,
  url: `/_bytecut/${path}`,
  role: "poster",
  format: "avif",
  width: 1280,
  height: 720,
  bytes: 900,
  sha256: H,
  quality: 55,
  effort: 4,
  at: 0.1,
  encoder: "libaom-av1 3.15.1",
  status: "written",
});

export function videoEntry(preset: string, withAudio = false): ManifestVideoSource {
  const audio = withAudio ? ", mp4a.40.2" : "";
  return {
    sha256: H,
    bytes: 90_000,
    width: 1280,
    height: 720,
    durationSec: 6,
    preset,
    placeholder: { kind: "dominant-color", value: "#0808f8" },
    outputs: [
      video("v/clip/clip-1280.av1.mp4", "av1", `av01.0.05M.08${audio}`),
      video("v/clip/clip-1280.h264.mp4", "h264", `avc1.64001f${audio}`),
      poster("v/clip/clip-poster.avif"),
    ],
  };
}

export function manifestWith(
  sources: Record<string, ManifestSource> = {},
  videos: Record<string, ManifestVideoSource> = {},
): Manifest {
  return { version: 3, tools: {}, publicPath: "/_bytecut", sources, videos };
}

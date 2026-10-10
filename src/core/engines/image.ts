import sharp from "sharp";
import type { ImageFormat } from "../presets/photo.js";
import { componentsFor, encodeBlurhash } from "../placeholders/blurhash.js";
import type { Placeholder, PlaceholderKind } from "../placeholders/types.js";
import { hasGpsIfd } from "./exif.js";
import type {
  EncodeRequest,
  EncodeResult,
  ImageAnalysis,
  ImageEngine,
  SourceFormat,
} from "./types.js";

function sourceFormat(format: string | undefined, compression: string | undefined): SourceFormat {
  switch (format) {
    case "jpeg":
    case "png":
    case "webp":
    case "gif":
      return format;
    case "heif":
      return compression === "av1" ? "avif" : "other";
    default:
      return "other";
  }
}

const SAMPLE_EDGE = 64;

/** Distinct 5-bit-per-channel colours in a small nearest-neighbour sample. */
async function sampleColors(input: Buffer): Promise<{ colorCount: number; sampleSize: number }> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize(SAMPLE_EDGE, SAMPLE_EDGE, { fit: "inside", kernel: "nearest" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const seen = new Set<number>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3]!;
    // Fully transparent pixels all look the same whatever their hidden RGB is.
    const key =
      a === 0
        ? 0xffffffff
        : ((data[i]! >> 3) << 15) |
          ((data[i + 1]! >> 3) << 10) |
          ((data[i + 2]! >> 3) << 5) |
          (a >> 6);
    seen.add(key);
  }
  return { colorCount: seen.size, sampleSize: info.width * info.height };
}

function encoderNames(): Record<ImageFormat, string> {
  const v = sharp.versions as Record<string, string | undefined>;
  // sharp's prebuilt libvips encodes AVIF through libheif with libaom.
  return {
    avif: `libaom-av1 ${v.aom ?? "unknown"}`,
    webp: `libwebp ${v.webp ?? "unknown"}`,
  };
}

const LQIP_EDGE = 16;
const BLURHASH_EDGE = 32;

async function makePlaceholder(input: Buffer, kind: PlaceholderKind): Promise<Placeholder> {
  switch (kind) {
    case "dominant-color": {
      const { dominant } = await sharp(input).rotate().stats();
      const hex = (n: number) => n.toString(16).padStart(2, "0");
      return { kind, value: `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}` };
    }
    case "lqip": {
      const webp = await sharp(input)
        .rotate()
        .resize(LQIP_EDGE, LQIP_EDGE, { fit: "inside" })
        .webp({ quality: 40, effort: 6 })
        .toBuffer();
      return { kind, value: `data:image/webp;base64,${webp.toString("base64")}` };
    }
    case "blurhash": {
      const { data, info } = await sharp(input)
        .rotate()
        .resize(BLURHASH_EDGE, BLURHASH_EDGE, { fit: "inside" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const [cx, cy] = componentsFor(info.width, info.height);
      return { kind, value: encodeBlurhash(data, info.width, info.height, cx, cy) };
    }
  }
}

export const sharpImageEngine: ImageEngine = {
  encoders: encoderNames,
  placeholder: makePlaceholder,

  versions() {
    const v = sharp.versions as Record<string, string | undefined>;
    return { sharp: v.sharp ?? "unknown", vips: v.vips ?? "unknown" };
  },

  async analyze(input): Promise<ImageAnalysis> {
    const meta = await sharp(input).metadata();
    // EXIF orientations 5–8 are transposed/rotated 90°, which swaps width and height.
    const swap = (meta.orientation ?? 1) >= 5;
    const width = (swap ? meta.height : meta.width) ?? 0;
    const height = (swap ? meta.width : meta.height) ?? 0;
    const format = sourceFormat(meta.format, meta.compression);
    const hasAlpha = meta.hasAlpha ?? false;

    let alphaUsed = false;
    if (hasAlpha && format !== "other") {
      // stats() are over the full image, so a single translucent pixel is not missed.
      const { channels } = await sharp(input).stats();
      const alpha = channels[channels.length - 1];
      alphaUsed = alpha !== undefined && alpha.min < 255;
    }
    const { colorCount, sampleSize } =
      format === "other" ? { colorCount: 0, sampleSize: 0 } : await sampleColors(input);

    return {
      width,
      height,
      format,
      hasAlpha,
      alphaUsed,
      animated: (meta.pages ?? 1) > 1,
      space: meta.space ?? "unknown",
      depth: meta.depth ?? "unknown",
      colorCount,
      sampleSize,
      metadata: {
        exif: meta.exif?.byteLength ?? 0,
        xmp: meta.xmp?.byteLength ?? 0,
        iptc: meta.iptc?.byteLength ?? 0,
        icc: meta.icc?.byteLength ?? 0,
        gps: meta.exif ? hasGpsIfd(meta.exif) : false,
      },
    };
  },

  async encode(input, request: EncodeRequest): Promise<EncodeResult> {
    const meta = await sharp(input).metadata();

    // rotate() with no argument applies EXIF orientation. Metadata is dropped by default
    // (so GPS and the rest of EXIF go), and keepIccProfile() retains colour accuracy.
    let image = sharp(input).rotate().resize({ width: request.width, withoutEnlargement: true });
    // A CMYK profile is meaningless on RGB output, so convert instead of keeping it.
    image = meta.space === "cmyk" ? image.toColourspace("srgb") : image.keepIccProfile();

    image =
      request.format === "avif"
        ? image.avif({
            quality: request.quality,
            effort: request.effort,
            lossless: request.lossless,
          })
        : image.webp({
            quality: request.quality,
            effort: request.effort,
            lossless: request.lossless,
          });

    const { data, info } = await image.toBuffer({ resolveWithObject: true });
    return {
      data,
      width: info.width,
      height: info.height,
      encoder: encoderNames()[request.format],
    };
  },
};

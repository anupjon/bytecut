import { VERSION, optimize } from "svgo";

export interface SvgAnalysis {
  /** Size after svgo, or null if svgo could not parse the file. */
  minifiedBytes: number | null;
  embeddedRasterBytes: number;
  embeddedRasterCount: number;
}

/** Behind an interface like the other engines (§3). */
export interface SvgEngine {
  analyze(text: string): SvgAnalysis;
  version(): string;
}

const EMBEDDED_RASTER =
  /data:image\/(?:png|jpe?g|webp|gif|avif)[^"')\s]*?;base64,([A-Za-z0-9+/=\s]+)/gi;

export const svgoEngine: SvgEngine = {
  version: () => `svgo ${VERSION}`,

  analyze(text) {
    let embeddedRasterBytes = 0;
    let embeddedRasterCount = 0;
    for (const match of text.matchAll(EMBEDDED_RASTER)) {
      embeddedRasterCount++;
      embeddedRasterBytes += match[1]!.replace(/\s/g, "").length;
    }

    let minifiedBytes: number | null = null;
    try {
      minifiedBytes = Buffer.byteLength(optimize(text, { multipass: true }).data);
    } catch {
      // Malformed SVG: leave it unreported rather than guess.
    }
    return { minifiedBytes, embeddedRasterBytes, embeddedRasterCount };
  },
};

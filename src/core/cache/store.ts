import type { ImageAnalysis } from "../engines/types.js";
import type { SvgAnalysis } from "../engines/svg.js";

export const CACHE_DIR = ".bytecut-cache";
export const CACHE_FILE = `${CACHE_DIR}/cache.json`;
const CACHE_IGNORE_FILE = `${CACHE_DIR}/.gitignore`;
const SCHEMA = 1;
const MAX_ANALYSES = 5000;
const MAX_ESTIMATES = 20000;

/** Estimated encoded size for one planned output. */
export interface EstimateEntry {
  bytes: number;
  /** `exact` came from encoding that width; `extrapolated` was scaled from a trial. */
  basis: "exact" | "extrapolated";
}

interface CacheData {
  schema: number;
  /** Anything that changes analysis or encoder output invalidates the whole cache. */
  fingerprint: string;
  analyses: Record<string, ImageAnalysis>;
  svgs: Record<string, SvgAnalysis>;
  estimates: Record<string, EstimateEntry>;
}

export interface CacheReader {
  readOutput(relativePosixPath: string): Promise<Buffer | null>;
}
export interface CacheWriter {
  writeOutput(relativePosixPath: string, data: Uint8Array): Promise<void>;
}

function trim<T>(record: Record<string, T>, max: number): void {
  const keys = Object.keys(record);
  // Objects keep insertion order, so the oldest entries go first.
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete record[key];
}

/**
 * Persistent cache of content-hash → analysis/estimates. It lives inside outDir (§6.2) in a
 * directory that ignores itself, so it never shows up in a commit even though outDir does.
 * It is only a cache: an unreadable or mismatched file just means a cold start.
 */
export class AnalysisCache {
  private dirty = false;

  private constructor(private readonly data: CacheData) {}

  static empty(fingerprint: string): AnalysisCache {
    return new AnalysisCache({
      schema: SCHEMA,
      fingerprint,
      analyses: {},
      svgs: {},
      estimates: {},
    });
  }

  static async load(reader: CacheReader, fingerprint: string): Promise<AnalysisCache> {
    try {
      const raw = await reader.readOutput(CACHE_FILE);
      if (raw) {
        const parsed = JSON.parse(raw.toString("utf8")) as Partial<CacheData>;
        if (
          parsed.schema === SCHEMA &&
          parsed.fingerprint === fingerprint &&
          parsed.analyses &&
          parsed.svgs &&
          parsed.estimates
        ) {
          return new AnalysisCache(parsed as CacheData);
        }
      }
    } catch {
      // Corrupt or unreadable: fall through to a cold cache.
    }
    return AnalysisCache.empty(fingerprint);
  }

  getAnalysis(sha: string): ImageAnalysis | undefined {
    return this.data.analyses[sha];
  }

  setAnalysis(sha: string, analysis: ImageAnalysis): void {
    this.data.analyses[sha] = analysis;
    this.dirty = true;
  }

  getSvg(sha: string): SvgAnalysis | undefined {
    return this.data.svgs[sha];
  }

  setSvg(sha: string, analysis: SvgAnalysis): void {
    this.data.svgs[sha] = analysis;
    this.dirty = true;
  }

  getEstimate(key: string): EstimateEntry | undefined {
    return this.data.estimates[key];
  }

  setEstimate(key: string, entry: EstimateEntry): void {
    this.data.estimates[key] = entry;
    this.dirty = true;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Writes only when something changed, so a warm run leaves the disk untouched. */
  async save(writer: CacheWriter): Promise<void> {
    if (!this.dirty) return;
    trim(this.data.analyses, MAX_ANALYSES);
    trim(this.data.svgs, MAX_ANALYSES);
    trim(this.data.estimates, MAX_ESTIMATES);
    await writer.writeOutput(CACHE_IGNORE_FILE, Buffer.from("*\n"));
    await writer.writeOutput(CACHE_FILE, Buffer.from(`${JSON.stringify(this.data)}\n`));
    this.dirty = false;
  }
}

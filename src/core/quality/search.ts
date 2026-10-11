import type { EncodeResult, ImageEngine, RawImage } from "../engines/types.js";
import type { ImageFormat, QualitySearch } from "../presets/photo.js";
import { crop, dropAlpha, flatten, hasTransparency, pickWindow } from "./pixels.js";
import type { QualityScorer } from "./types.js";

export interface SearchRequest {
  engine: ImageEngine;
  scorer: QualityScorer;
  /** The source file's bytes. */
  input: Buffer;
  format: ImageFormat;
  /** The width the plan lists. */
  width: number;
  effort: number;
  search: QualitySearch;
  /** The next smaller planned width: stepping down never goes at or below it. */
  minWidth: number;
  signal?: AbortSignal | undefined;
  /** Side of the sampled window; 512 unless a test wants it smaller. */
  cropSize?: number;
}

export type SearchOutcome =
  | {
      ok: true;
      quality: number;
      /** The width actually produced: smaller than planned when it was stepped down. */
      width: number;
      encoded: EncodeResult;
      score: number;
      /** Encodes performed (crop and full size), for reporting. */
      encodes: number;
      notes: string[];
    }
  | {
      ok: false;
      reason: string;
      encodes: number;
      /** The search was cancelled rather than failing. */
      cancelled?: boolean;
      /** The input could not be searched at all; the caller may use the fixed quality. */
      unsearchable?: boolean;
    };

interface AtWidthOk {
  ok: true;
  quality: number;
  encoded: EncodeResult;
  score: number;
  notes: string[];
}
type AtWidth = AtWidthOk | { ok: false; kind: "size" | "score" | "cancelled"; reason: string };

const MAX_BUMPS = 8;
/** Each step down is 10% narrower; the 1920 → 1280 range takes four. */
const STEP = 0.9;
/** Stepping down never goes below this share of the planned width. */
const MIN_WIDTH_FRACTION = 0.5;

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

class Cancelled extends Error {}

/**
 * Finds the smallest quality whose output still scores `search.target`, and, when a size cap
 * is set, fits it by lowering quality to `floor` and then stepping the width down. Works on a
 * ~512 px window (cheap), then proves the answer on the full-size output. Deterministic: the
 * same pixels, parameters and encoder give the same quality, whatever the timing.
 */
export async function searchQuality(request: SearchRequest): Promise<SearchOutcome> {
  const { engine, scorer, search } = request;
  if (!engine.decodeRaw || !engine.encodeRaw) {
    return {
      ok: false,
      reason: "this image engine cannot decode raw pixels",
      encodes: 0,
      unsearchable: true,
    };
  }
  const decodeRaw = engine.decodeRaw.bind(engine);
  const encodeRaw = engine.encodeRaw.bind(engine);
  let encodes = 0;

  const checkAbort = () => {
    if (request.signal?.aborted) throw new Cancelled();
  };

  async function atWidth(width: number): Promise<AtWidth> {
    const ref = await decodeRaw(request.input, { width });
    if (Math.min(ref.width, ref.height) < 8) {
      throw new Unsearchable(`a ${ref.width}x${ref.height} image is too small to score`);
    }
    const opaque = !hasTransparency(ref);
    const backgrounds = opaque ? (["white"] as const) : (["white", "black"] as const);

    /** The lower score over the backgrounds an alpha image may sit on. */
    const scoreAgainst = async (reference: RawImage, candidate: RawImage): Promise<number> => {
      let worst = Infinity;
      for (const bg of backgrounds) {
        worst = Math.min(worst, await scorer.score(flatten(reference, bg), flatten(candidate, bg)));
      }
      return worst;
    };

    const window = pickWindow(ref, request.cropSize ?? 512);
    const refCrop = crop(ref, window);
    const cropInput = opaque ? dropAlpha(refCrop) : refCrop;
    const cropScores = new Map<number, number>();

    const cropScore = async (quality: number): Promise<number> => {
      const known = cropScores.get(quality);
      if (known !== undefined) return known;
      checkAbort();
      const encoded = await encodeRaw(cropInput, {
        format: request.format,
        quality,
        effort: request.effort,
      });
      encodes++;
      const decoded = await decodeRaw(Buffer.from(encoded.data), {});
      const score = await scoreAgainst(refCrop, decoded);
      cropScores.set(quality, score);
      return score;
    };

    /** Smallest quality in 1..100 whose sampled score reaches `minScore`. */
    const smallestQuality = async (
      minScore: number,
    ): Promise<{ quality: number; reached: boolean }> => {
      if ((await cropScore(100)) < minScore) return { quality: 100, reached: false };
      let lo = 1;
      let hi = 100;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((await cropScore(mid)) >= minScore) hi = mid;
        else lo = mid + 1;
      }
      return { quality: lo, reached: true };
    };

    const full = async (quality: number) => {
      checkAbort();
      const encoded = await engine.encode(request.input, {
        format: request.format,
        width,
        lossless: false,
        quality,
        effort: request.effort,
      });
      encodes++;
      const decoded = await decodeRaw(Buffer.from(encoded.data), {});
      if (decoded.width !== ref.width || decoded.height !== ref.height) {
        throw new Error(
          `the ${request.format} output is ${decoded.width}x${decoded.height}, expected ${ref.width}x${ref.height}`,
        );
      }
      return { encoded, score: await scoreAgainst(ref, decoded) };
    };

    const notes: string[] = [];
    const target = await smallestQuality(search.target);
    if (!target.reached) {
      notes.push(
        `the sampled region does not reach ${search.target} even at quality 100; confirming at full size`,
      );
    }
    let quality = target.quality;
    let current = await full(quality);

    // The sample said `quality`; the whole image decides.
    let bumps = 0;
    while (current.score < search.target && quality < 100 && bumps < MAX_BUMPS) {
      const next = Math.min(100, quality + (bumps < 4 ? 1 : 2));
      notes.push(
        `quality ${quality} scored ${current.score.toFixed(2)} at full size (target ${search.target}); raised to ${next}`,
      );
      quality = next;
      current = await full(quality);
      bumps++;
    }
    if (current.score < search.target) {
      return {
        ok: false,
        kind: "score",
        reason: `quality ${quality} scores ${current.score.toFixed(1)}, below the target ${search.target}`,
      };
    }

    const cap = search.maxBytes;
    if (cap === undefined || current.encoded.data.byteLength <= cap) {
      return { ok: true, quality, encoded: current.encoded, score: current.score, notes };
    }

    // Over the cap: how far may quality fall, and does the file fit there?
    const floor = search.floor ?? search.target;
    let lowQuality = Math.min((await smallestQuality(floor)).quality, quality);
    let low = lowQuality === quality ? current : await full(lowQuality);
    let lowBumps = 0;
    while (low.score < floor && lowQuality < quality && lowBumps < MAX_BUMPS) {
      lowQuality++;
      low = lowQuality === quality ? current : await full(lowQuality);
      lowBumps++;
    }
    if (low.encoded.data.byteLength > cap) {
      return {
        ok: false,
        kind: "size",
        reason: `${kb(low.encoded.data.byteLength)} at the score floor ${floor} (quality ${lowQuality}) is over the ${kb(cap)} cap`,
      };
    }

    // Largest quality in [lowQuality, quality) that fits: sizes grow with quality.
    let best = { quality: lowQuality, ...low };
    let lo = lowQuality;
    let hi = quality;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const candidate = await full(mid);
      if (candidate.encoded.data.byteLength <= cap && candidate.score >= floor) {
        lo = mid;
        best = { quality: mid, ...candidate };
      } else hi = mid;
    }
    notes.push(
      `${kb(current.encoded.data.byteLength)} at quality ${quality} is over ${kb(cap)}; lowered to ${best.quality} (score ${best.score.toFixed(1)}, floor ${floor})`,
    );
    return { ok: true, quality: best.quality, encoded: best.encoded, score: best.score, notes };
  }

  try {
    let width = request.width;
    let last: AtWidth = await atWidth(width);
    if (last.ok) return { ...last, width, encodes };

    // Only a size problem is solved by a smaller picture.
    const widthNotes: string[] = [];
    while (!last.ok && last.kind === "size") {
      const next = even(width * STEP);
      // A picture half as wide is no longer the one that was asked for.
      const halfWidth = Math.ceil(request.width * MIN_WIDTH_FRACTION);
      if (next <= request.minWidth || next < halfWidth || next >= width) {
        const stoppedAt =
          next <= request.minWidth
            ? `the next planned width (${request.minWidth}px)`
            : `half the planned width (${halfWidth}px)`;
        return {
          ok: false,
          encodes,
          reason: `${last.reason}; stepping down reached ${stoppedAt} without fitting`,
        };
      }
      widthNotes.push(`${width}px did not fit (${last.reason})`);
      width = next;
      last = await atWidth(width);
    }
    if (last.ok) {
      return {
        ok: true,
        quality: last.quality,
        width,
        encoded: last.encoded,
        score: last.score,
        encodes,
        notes: [
          `stepped the width down from ${request.width}px to ${width}px to fit (${widthNotes.length} wider ${widthNotes.length === 1 ? "size" : "sizes"} did not)`,
          ...last.notes,
        ],
      };
    }
    return { ok: false, encodes, reason: last.reason };
  } catch (error) {
    if (error instanceof Cancelled)
      return { ok: false, encodes, reason: "cancelled", cancelled: true };
    if (error instanceof Unsearchable) {
      return { ok: false, encodes, reason: error.message, unsearchable: true };
    }
    throw error;
  }
}

class Unsearchable extends Error {}

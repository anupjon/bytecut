import { open } from "node:fs/promises";

/**
 * The exact RFC 6381 codec string a browser needs in `<source type>` to decide whether it can
 * play a file BEFORE downloading it. Without it a browser that cannot decode AV1 still picks
 * the AV1 `<source>` (it only checks the container), so the H.264 fallback is never tried.
 *
 * Read from the MP4's own `avcC` / `av1C` boxes, so it is exact rather than guessed from a
 * resolution table.
 */

interface Box {
  type: string;
  /** Offset of the payload (after the header) within the buffer. */
  start: number;
  end: number;
}

function* boxes(buf: Buffer, start: number, end: number): Generator<Box> {
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) return;
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

function find(buf: Buffer, parent: { start: number; end: number }, type: string): Box | undefined {
  for (const box of boxes(buf, parent.start, parent.end)) if (box.type === type) return box;
  return undefined;
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/** `avc1.PPCCLL` from an avcC payload. */
export function avcCodecString(avcC: Buffer): string | null {
  if (avcC.length < 4) return null;
  return `avc1.${hex2(avcC[1]!)}${hex2(avcC[2]!)}${hex2(avcC[3]!)}`;
}

/** `av01.P.LLT.DD` from an av1C payload (shortened form: 4:2:0 and default colour). */
export function av1CodecString(av1C: Buffer): string | null {
  if (av1C.length < 4 || (av1C[0]! & 0x80) === 0) return null;
  const profile = av1C[1]! >> 5;
  const level = av1C[1]! & 0x1f;
  const tier = (av1C[2]! >> 7) & 1;
  const highBitdepth = (av1C[2]! >> 6) & 1;
  const twelveBit = (av1C[2]! >> 5) & 1;
  const depth = highBitdepth ? (twelveBit ? 12 : 10) : 8;
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier ? "H" : "M"}.${String(depth).padStart(2, "0")}`;
}

/**
 * The first video track's codec string, or null for anything that is not H.264/AV1 in an
 * ISO-BMFF file. Reads only the moov box.
 */
export async function readVideoCodecString(path: string): Promise<string | null> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(16);
    let offset = 0;
    for (let guard = 0; guard < 64 && offset + 8 <= size; guard++) {
      const { bytesRead } = await file.read(header, 0, 16, offset);
      if (bytesRead < 8) return null;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      let headerSize = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) return null;
        boxSize = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = size - offset;
      }
      if (boxSize < headerSize) return null;

      if (type === "moov") {
        // A moov is metadata (tables), a few MB at worst; read it whole to walk it in memory.
        const payload = Buffer.alloc(boxSize - headerSize);
        await file.read(payload, 0, payload.length, offset + headerSize);
        return codecFromMoov(payload);
      }
      offset += boxSize;
    }
    return null;
  } finally {
    await file.close();
  }
}

function codecFromMoov(moov: Buffer): string | null {
  const root = { start: 0, end: moov.length };
  for (const trak of boxes(moov, root.start, root.end)) {
    if (trak.type !== "trak") continue;
    const mdia = find(moov, trak, "mdia");
    if (!mdia) continue;
    const hdlr = find(moov, mdia, "hdlr");
    // hdlr payload: version/flags(4) + pre_defined(4) + handler_type(4)
    if (!hdlr || moov.toString("latin1", hdlr.start + 8, hdlr.start + 12) !== "vide") continue;

    const minf = find(moov, mdia, "minf");
    const stbl = minf && find(moov, minf, "stbl");
    const stsd = stbl && find(moov, stbl, "stsd");
    if (!stsd) continue;
    // stsd payload: version/flags(4) + entry_count(4), then sample entries.
    for (const entry of boxes(moov, stsd.start + 8, stsd.end)) {
      // VisualSampleEntry has 78 bytes of fields before its child boxes.
      const childStart = entry.start + 78;
      if (entry.type === "avc1" || entry.type === "avc3") {
        const avcC = find(moov, { start: childStart, end: entry.end }, "avcC");
        if (avcC) return avcCodecString(moov.subarray(avcC.start, avcC.end));
      }
      if (entry.type === "av01") {
        const av1C = find(moov, { start: childStart, end: entry.end }, "av1C");
        if (av1C) return av1CodecString(moov.subarray(av1C.start, av1C.end));
      }
    }
  }
  return null;
}

/**
 * Conservative AV1 string for a manifest written before codec strings were recorded. Level
 * follows the picture size table of the AV1 spec; frame rate is ignored (rarely binding).
 */
export function fallbackAv1CodecString(width: number, height: number): string {
  const pixels = width * height;
  const level =
    pixels <= 147_456
      ? 0
      : pixels <= 278_784
        ? 1
        : pixels <= 665_856
          ? 4
          : pixels <= 1_065_024
            ? 5
            : pixels <= 2_359_296
              ? 8
              : pixels <= 8_912_896
                ? 12
                : 16;
  return `av01.0.${String(level).padStart(2, "0")}M.08`;
}

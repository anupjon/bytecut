/**
 * True when an EXIF block has a GPS IFD pointer (tag 0x8825) in IFD0. Reads only the TIFF
 * header and IFD0 entry tags, so it never trusts offsets beyond the buffer.
 */
export function hasGpsIfd(exif: Buffer): boolean {
  // sharp returns EXIF with the "Exif\0\0" prefix; the TIFF header follows it.
  const base = exif.subarray(0, 6).toString("latin1") === "Exif\0\0" ? 6 : 0;
  if (exif.length < base + 8) return false;

  const order = exif.toString("latin1", base, base + 2);
  const little = order === "II";
  if (!little && order !== "MM") return false;
  const u16 = (at: number) => (little ? exif.readUInt16LE(at) : exif.readUInt16BE(at));
  const u32 = (at: number) => (little ? exif.readUInt32LE(at) : exif.readUInt32BE(at));

  const ifd0 = base + u32(base + 4);
  if (ifd0 + 2 > exif.length) return false;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > exif.length) return false;
    if (u16(entry) === 0x8825) return true;
  }
  return false;
}

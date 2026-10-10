/**
 * Writes the SSIMULACRA2 fixture pairs to test/fixtures/ssimulacra2/.
 *
 * These files ARE committed, unlike the other fixtures: their golden scores were recorded
 * from the reference C++ tool against these exact pixels, and a different libjpeg or libwebp
 * would produce different distortions. Regenerating them means re-recording the goldens.
 *
 *   pnpm exec tsx scripts/make-ssim-fixtures.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const W = 192;
const H = 128;
const out = join(import.meta.dirname, "../test/fixtures/ssimulacra2");

/** Gradients, hard edges, diagonal lines and flat blocks: what photos are not. */
function synthetic(): Buffer {
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      let r = (x * 255) / W;
      let g = (y * 255) / H;
      let b = 128 + 100 * Math.sin((x + y) / 9);
      if (x > 40 && x < 100 && y > 30 && y < 90) [r, g, b] = [220, 40, 60];
      if (Math.abs(x - y * 1.4 - 20) < 2) [r, g, b] = [0, 0, 0];
      if (y > 100 && (x >> 3) % 2 === 0) [r, g, b] = [240, 240, 240];
      px[i] = Math.max(0, Math.min(255, r));
      px[i + 1] = Math.max(0, Math.min(255, g));
      px[i + 2] = Math.max(0, Math.min(255, b));
    }
  }
  return px;
}

async function distortions(reference: Buffer): Promise<Record<string, Buffer>> {
  const raw = { raw: { width: W, height: H, channels: 3 as const } };
  const decode = (encoded: Buffer) => sharp(encoded).removeAlpha().png().toBuffer();
  const png = (buffer: Buffer) => sharp(buffer, raw).png().toBuffer();
  const base = sharp(reference, raw);
  return {
    "jpeg-q20": await decode(await base.clone().jpeg({ quality: 20 }).toBuffer()),
    "jpeg-q50": await decode(await base.clone().jpeg({ quality: 50 }).toBuffer()),
    "jpeg-q85": await decode(await base.clone().jpeg({ quality: 85 }).toBuffer()),
    "webp-q30": await decode(await base.clone().webp({ quality: 30 }).toBuffer()),
    "avif-q35": await decode(await base.clone().avif({ quality: 35, effort: 4 }).toBuffer()),
    blur: await decode(await base.clone().blur(1.6).png().toBuffer()),
    // Deterministic pseudo-noise: a fixed LCG, not Math.random.
    noise: await png(
      (() => {
        const noisy = Buffer.from(reference);
        let seed = 12345;
        for (let i = 0; i < noisy.length; i++) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          const n = ((seed >> 16) % 41) - 20;
          noisy[i] = Math.max(0, Math.min(255, noisy[i]! + n));
        }
        return noisy;
      })(),
    ),
    "color-shift": await png(
      (() => {
        const shifted = Buffer.from(reference);
        for (let i = 0; i < shifted.length; i += 3) {
          shifted[i] = Math.min(255, shifted[i]! + 18);
          shifted[i + 2] = Math.max(0, shifted[i + 2]! - 18);
        }
        return shifted;
      })(),
    ),
  };
}

await mkdir(out, { recursive: true });
const photo = await sharp(join(import.meta.dirname, "../test/fixtures/images/photo.jpg"))
  .resize(W, H, { fit: "cover" })
  .removeAlpha()
  .raw()
  .toBuffer();

for (const [name, pixels] of [
  ["photo", photo],
  ["synthetic", synthetic()],
] as const) {
  await writeFile(
    join(out, `${name}-ref.png`),
    await sharp(pixels, { raw: { width: W, height: H, channels: 3 } })
      .png()
      .toBuffer(),
  );
  for (const [kind, data] of Object.entries(await distortions(pixels))) {
    await writeFile(join(out, `${name}-${kind}.png`), data);
  }
}
console.log(`wrote fixtures to ${out}`);

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

/** Deterministic pseudo-random bytes, so fixtures are reproducible without committing binaries. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Smooth gradients plus mild noise: photo-like enough that AVIF/WebP beat JPEG/PNG. */
function photoPixels(width: number, height: number, seed: number, noise: number): Buffer {
  const random = lcg(seed);
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const n = (random() - 0.5) * noise;
      data[i] = 128 + 100 * Math.sin(x / 90 + seed) + n;
      data[i + 1] = 128 + 90 * Math.sin(y / 70 + seed * 2) + n;
      data[i + 2] = 128 + 80 * Math.sin((x + y) / 130) + n;
    }
  }
  return data;
}

function photo(width: number, height: number, seed: number, noise = 40) {
  return sharp(photoPixels(width, height, seed, noise), {
    raw: { width, height, channels: 3 },
  }).blur(1.5);
}

export const IMAGE_FIXTURES = [
  "photo.jpg",
  "small.jpg",
  "oversized.jpg",
  "rotated-exif.jpg",
  "gps.jpg",
  "p3.jpg",
  "photo-as-png.png",
  "flat-alpha.png",
] as const;

/** Writes the M1 image fixtures into `dir` and returns their names. */
export async function makeImageFixtures(dir: string): Promise<readonly string[]> {
  await mkdir(dir, { recursive: true });
  const write = (name: string, data: Buffer) => writeFile(join(dir, name), data);

  await write("photo.jpg", await photo(1400, 900, 1).jpeg({ quality: 85 }).toBuffer());
  await write("small.jpg", await photo(300, 200, 2).jpeg({ quality: 85 }).toBuffer());
  await write("oversized.jpg", await photo(2600, 1400, 3, 8).jpeg({ quality: 80 }).toBuffer());

  // Stored 800x500 with EXIF orientation 6, so it displays as 500x800.
  await write(
    "rotated-exif.jpg",
    await photo(800, 500, 4).jpeg({ quality: 85 }).withMetadata({ orientation: 6 }).toBuffer(),
  );

  await write(
    "gps.jpg",
    await photo(700, 450, 5)
      .jpeg({ quality: 85 })
      .withExif({
        IFD0: { Make: "bytecut-fixture" },
        IFD3: {
          GPSLatitudeRef: "N",
          GPSLatitude: "51/1 30/1 0/1",
          GPSLongitudeRef: "W",
          GPSLongitude: "0/1 7/1 0/1",
        },
      })
      .toBuffer(),
  );

  await write(
    "p3.jpg",
    await photo(500, 320, 6).withIccProfile("p3").jpeg({ quality: 85 }).toBuffer(),
  );

  await write("photo-as-png.png", await photo(400, 260, 7, 12).png().toBuffer());

  await write(
    "flat-alpha.png",
    await sharp({
      create: {
        width: 600,
        height: 400,
        channels: 4,
        background: { r: 20, g: 120, b: 220, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer(),
  );

  return IMAGE_FIXTURES;
}

/** Frames of an animated GIF: a coloured square moving across a flat background. */
async function animatedGif(): Promise<Buffer> {
  const width = 40;
  const frames = [0, 12, 24].map((x) => {
    const data = Buffer.alloc(width * width * 3, 240);
    for (let y = 8; y < 32; y++) {
      for (let dx = 0; dx < 16; dx++) {
        const i = (y * width + x + dx) * 3;
        data[i] = 220;
        data[i + 1] = 40;
        data[i + 2] = 40;
      }
    }
    return data;
  });
  return sharp(Buffer.concat(frames), {
    raw: { width, height: width * frames.length, channels: 3, pageHeight: width },
  })
    .gif({ loop: 0, delay: [100, 100, 100] })
    .toBuffer();
}

const UNMINIFIED_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Some Editor 1.0 -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="100" height="100" viewBox="0 0 100 100">
  <metadata>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description about="">
        <dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Mark</dc:title>
      </rdf:Description>
    </rdf:RDF>
  </metadata>
  <!-- background -->
  <g id="layer1" sodipodi:insensitive="true">
    <rect x="0" y="0" width="100" height="100" fill="#ff0000" stroke="none" />
    <!-- foreground -->
    <circle cx="50" cy="50" r="30" fill="#ffffff" stroke="none" />
  </g>
</svg>
`;

/**
 * A small Next.js-shaped project that trips every M3 rule at least once. Written to `dir`;
 * returns the project-relative path of each file created.
 */
export async function makeAuditProject(dir: string): Promise<string[]> {
  const files: Array<[string, Buffer | string]> = [];
  const add = (path: string, content: Buffer | string) => files.push([path, content]);

  add("package.json", JSON.stringify({ name: "fixture", dependencies: { next: "15.0.0" } }));
  add(".gitignore", "ignored/\n");
  add(
    "app/page.tsx",
    [
      "export default function Page() {",
      '  return <><img src="/img/hero.jpg" /><img src="/img/photo-big.jpg" />',
      '  <img src="/img/diagram.png" /><img src="/img/logo.png" />',
      '  <img src="/img/loader.gif" /><img src="/icons/mark.svg" /><img src="/img/legacy.webp" /></>;',
      "}",
    ].join("\n"),
  );

  add("public/img/hero.jpg", await photo(2400, 1300, 11, 10).jpeg({ quality: 80 }).toBuffer());
  add("public/img/photo-big.jpg", await photo(2800, 1800, 12, 6).jpeg({ quality: 70 }).toBuffer());
  add("public/img/diagram.png", await photo(400, 300, 13, 12).png().toBuffer());

  const logo = await sharp({
    create: {
      width: 300,
      height: 300,
      channels: 4,
      background: { r: 20, g: 120, b: 220, alpha: 0.6 },
    },
  })
    .png()
    .toBuffer();
  add("public/img/logo.png", logo);
  add("public/img/logo-copy.png", logo);

  add("public/img/loader.gif", await animatedGif());
  add("public/img/still.gif", await photo(120, 80, 14, 0).gif().toBuffer());
  add("public/icons/mark.svg", UNMINIFIED_SVG);

  const inline = await photo(96, 96, 15, 90).png().toBuffer();
  add(
    "public/icons/inline-photo.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="96" height="96"><image width="96" height="96" xlink:href="data:image/png;base64,${inline.toString("base64")}"/></svg>`,
  );

  add("public/img/legacy.webp", await photo(800, 500, 16, 30).webp({ quality: 100 }).toBuffer());
  add(
    "public/img/cmyk.jpg",
    await photo(300, 200, 17, 20).toColourspace("cmyk").jpeg({ quality: 85 }).toBuffer(),
  );

  // 8-bit samples widened to a 16-bit PNG: the file really is ushort, which is what the rule sees.
  add("public/img/deep.png", await photo(120, 80, 20, 30).toColourspace("rgb16").png().toBuffer());

  add(
    "public/img/with-meta.jpg",
    await photo(600, 400, 18, 20)
      .jpeg({ quality: 85 })
      .withExif({
        IFD0: { Make: "bytecut-fixture", ImageDescription: "x".repeat(3000), Copyright: "c" },
        IFD3: {
          GPSLatitudeRef: "N",
          GPSLatitude: "51/1 30/1 0/1",
          GPSLongitudeRef: "W",
          GPSLongitude: "0/1 7/1 0/1",
        },
      })
      .toBuffer(),
  );

  add("public/ignored/skip.jpg", await photo(200, 120, 19, 20).jpeg().toBuffer());
  add("public/clip.mp4", Buffer.alloc(1200, 7));

  for (const [path, content] of files) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return files.map(([path]) => path).sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = resolve("test/fixtures/images");
  const names = await makeImageFixtures(dir);
  console.log(`Wrote ${names.length} fixtures to ${dir}`);
}

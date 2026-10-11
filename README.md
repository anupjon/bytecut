# bytecut

Audit and optimize the images and videos in a web project, from the terminal.

```sh
npx bytecut
```

With no configuration, bytecut detects your framework (Next.js, Astro, Vite or a static
site), scans the asset folders, shows what is too heavy and how much you would save, and
optimizes on Enter. Your original files are never modified: outputs go to a separate folder
that mirrors your source tree, and that folder is meant to be committed.

## What you get

By default each image becomes **one JPEG**, with the longest side capped at 1920 px (a
landscape image is 1920 wide, a portrait one is 1920 tall, nothing is ever upscaled). Metadata
and GPS are stripped, orientation is applied and the colour profile is kept.

```
public/img/hero.jpg  →  public/_bytecut/img/hero-1920.jpg
                         public/_bytecut/bytecut-manifest.json
```

- **Transparency is preserved.** A source that really uses alpha gets a lossless PNG instead of
  a JPEG, and so does flat art such as icons and logos.
- **WebP and AVIF are opt-in** (see [Configuration](#configuration)).
- **A file is only written if it is smaller** than the source; otherwise it is reported as
  "already optimal".
- **Videos and animated GIFs** become AV1 and H.264 MP4 plus a poster, using your own
  `ffmpeg` (see [Video](#video)).

Outputs are flat: an image at the top of your static folder lands directly in `_bytecut/`, and
one in a subfolder keeps that subfolder (`public/img/hero.jpg` → `_bytecut/img/hero-1920.jpg`).
There is no extra folder per image.

Re-running is cheap: unchanged sources are skipped by content hash, and the manifest is
byte-identical when nothing changed, so it diffs cleanly in pull requests.

## Commands

| Command                       | What it does                                                              |
| ----------------------------- | ------------------------------------------------------------------------- |
| `bytecut`                     | Interactive session on a TTY; prints the audit elsewhere                  |
| `bytecut audit`               | Report what is too heavy, with estimated savings                          |
| `bytecut optimize [paths] -y` | Write optimized files. Without `-y` it prints the plan and writes nothing |
| `bytecut snippet <file>`      | Print the `<picture>` / `<video>` markup (HTML or JSX) for a file         |
| `bytecut compare <file>`      | Serve a before/after page on `127.0.0.1` (random port, private path)      |
| `bytecut explain <file>`      | Show which rule chose a file's preset and what it resolves to             |
| `bytecut init`                | Write a minimal `bytecut.config.json` with only non-default choices       |
| `bytecut check`               | CI mode: exit 1 if a finding is an error, 2 if it could not run           |
| `bytecut doctor`              | Report Node, sharp, ffmpeg, the scorer, and what is degraded              |

Useful flags: `--dry-run --json` prints the plan as JSON and `--plan <file>` executes a saved
one; `--out-dir`, `--preset`, `--force`, `--placeholder dominant-color|lqip|blurhash|none`.

In the interactive session: `space` toggles a file, `enter` reviews and runs, `p` changes the
preset, `o` the output folder, `d` details, `esc` cancels, `?` help. Type `/` for commands
(`/snippet @file`, `/compare @file`, `/save`) and `@` to mention a file.

## Configuration

Everything is optional. Config is only needed to make a choice stick. Put it in
`bytecut.config.json` (or `.ts`, `.mjs`, `.toml`); unknown keys are errors.

```json
{
  "presets": {
    "photo": { "formats": ["jpg", "webp", "avif"] },
    "gallery": {
      "extends": "photo",
      "maxEdge": 1280,
      "ssimulacra2": 80,
      "maxSize": "150 KB",
      "floor": 65
    },
    "loop": { "extends": "background-video", "vmaf": 92 }
  },
  "assets": { "public/gallery/**": "gallery", "public/loops/*.mp4": "loop" },
  "budgets": { "maxFileSize": "250 KB", "maxTotalSize": "5 MB" }
}
```

- **Presets**: built-in `photo`, `hero`, `icon`, `background-video`, `content-video` and
  `gif-to-video`. Add your own with `extends`; the first matching `assets` glob wins.
- **Size**: `maxEdge` caps the longest side; `widths` lists widths instead (a responsive set).
- **Formats**: `jpg` (default), `png`, `webp`, `avif`. A `<picture>` lists AVIF, then WebP, and
  the JPEG is the `<img>`.
- **Quality**: `target` (`low`, `balanced`, `high`, `lossless`), or `quality` per format.
- **Perceptual targets**: see below.

## Quality targets

Instead of a fixed quality you can ask for a score. bytecut then finds the **smallest** output
that still meets it:

- `ssimulacra2: 80` (images and video) searches quality on a representative crop, then
  confirms on the full-size output.
- `maxSize` with a required `floor` lowers quality, then steps the width down, to fit a size
  cap. A constraint that cannot be met writes nothing and fails the run; it is never silently
  exceeded.
- `vmaf: 92` (video) uses ffmpeg's `libvmaf`. Without it, the preset's fixed quality is used
  and a warning says so.

SSIMULACRA2 runs as WebAssembly in worker threads, so no native binary is needed. A native
`ssimulacra2` is used if one is found (`--ssimulacra2`, `BYTECUT_SSIMULACRA2`,
`ssimulacra2Path`, or `PATH`), as a speed-up only.

## Video

Estimating a large video encodes real samples, so the first scan of a 4K file can take a minute or
more; the screen shows which sample it is on, and the result is cached by content hash.

bytecut uses **your own** `ffmpeg` and `ffprobe` (`--ffmpeg`, `BYTECUT_FFMPEG`, `ffmpegPath`, or
`PATH`). It never downloads or bundles one. Without ffmpeg images work fully and videos are
listed as "needs ffmpeg" with the install command for your OS. Without an AV1 encoder you still
get the H.264 file and the poster. `bytecut doctor` shows exactly what is available.

## CI

```sh
npx bytecut check                       # exit 1 on an error finding
npx bytecut check --fail-on warn        # stricter
npx bytecut check --changed origin/main # only files changed since a ref
npx bytecut check --report md           # a Markdown report for a PR comment
```

`project/over-budget` is an error by default; other rules are promoted or silenced under
`audit.rules`.

## Guarantees

- Sources are read-only. bytecut only writes inside the output folder (and the config file,
  and only when you ask it to), atomically, so a cancelled run never leaves a half-written
  file.
- It only deletes files listed in its manifest, and never without confirmation or an explicit flag.
- No network access at runtime: no telemetry, no update checks, no downloads.
- Same input, same settings and same tool versions give the same bytes where the encoder allows.

## Requirements

Node.js 22 or newer. Images use [sharp](https://sharp.pixelplumbing.com). Developed and tested
on Linux; macOS and Windows have not been verified yet.

## Licence

MIT. The bundled SSIMULACRA2 build (`bytecut-ssimulacra2`) is a WebAssembly compilation of
[rust-av/ssimulacra2](https://github.com/rust-av/ssimulacra2) and is BSD-2-Clause.

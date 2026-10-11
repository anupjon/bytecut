# AGENTS.md — bytecut

Instructions for AI coding agents (Claude Code, opencode, etc.) building this project.
Read this whole file before starting any task. When this file and a request conflict, ask.

---

## 1. What we're building

`bytecut` is a CLI + terminal UI that audits and optimizes images and videos in web projects.
It's for **web developers prepping site assets**. Interaction style is modeled on Claude Code /
opencode: a persistent interactive session with a command bar, slash commands, `@` file mentions,
a plan-then-approve flow, and live progress.

Core promise: **`npx bytecut` works with zero config.** It detects the framework, scans the asset
folders, shows what's too heavy with estimated savings, and optimizes on Enter. Config is optional
and only needed to make choices stick (CI budgets, overriding a heuristic, team consistency).

### Settled decisions (do not revisit without asking)

- Audience: web devs. Not a general-purpose consumer media tool.
- No AI/LLM layer. Input is slash commands, flags and `@` mentions only.
- Language: TypeScript on Node. Distributed via npm, runnable with `npx`.
- Outputs go to a **separate output folder** that mirrors the source tree. Sources are never modified.
- The output folder (including the manifest) is **committed to git by default**, not gitignored. Deploys then need no ffmpeg or encoding step, and output diffs are reviewable in PRs.
- Zero-config by default; `bytecut.config.ts` is optional and every field in it is optional.
- When a heuristic is unsure, choose the conservative option (keep audio, keep resolution, lossless for ambiguous PNGs).

---

## 2. Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js LTS (≥ 22), ESM only |
| Package manager | pnpm |
| Language | TypeScript, `strict: true` |
| TUI | Ink (React for terminals) |
| CLI parsing (headless) | `citty` (picked in M0) |
| Images | `sharp` (libvips): resize, JPEG/WebP/AVIF/PNG encode, metadata |
| SVG | `svgo` |
| Video | the user's own `ffmpeg` + `ffprobe` (not bundled), invoked as child processes — see §4 "ffmpeg sourcing" |
| Hashing | `node:crypto` (sha256 of file contents) |
| Tests | `vitest` |
| Build | `tsup` (or `tsdown`) to a single ESM bundle with a `bin` entry |
| Lint/format | `eslint` + `prettier` (picked in M0) |

Do not add dependencies beyond this list without stating why in the PR/commit message. Prefer
small, well-maintained packages; avoid anything that needs a postinstall download besides sharp.

---

## 3. Architecture

```
TUI (Ink)            Headless CLI (flags, -y)
      └──────────┬──────────┘
            Commands layer        (audit, optimize, check, init, explain, snippet, compare, doctor)
                 │
     Scanner → Prober → Classifier → Planner
                 │            (preset per file, outputs, estimates)
                 ▼
          Plan (plain JSON-serializable object)
                 │
          Executor (job queue, worker pool, cancel)
                 │
     Engines: image (sharp) · svg (svgo) · video (ffmpeg)
                 │
          Manifest + cache  (outDir/bytecut-manifest.json)
```

Rules:
- **The core never imports Ink/React.** `src/core/**` must be usable as a library and from headless mode.
- **The Plan is data.** Everything the executor does must be described by the Plan. The TUI renders and edits Plans; headless mode can `--dry-run --json` a Plan and later execute a saved one.
- **Engines are behind interfaces** (`ImageEngine`, `VideoEngine`, `SvgEngine`) so they can be faked in tests.
- **All file writes go through one module** (`src/core/fs-safe.ts`) that enforces the guardrails in §6.

### Suggested layout

```
src/
  cli/            entry, arg parsing, headless commands
  tui/            Ink components, views, keybindings, command bar
  core/
    scan/         globbing, framework detection, ignore handling
    probe/        sharp metadata, ffprobe wrappers
    classify/     preset heuristics
    presets/      built-in presets, resolution (extends + overrides)
    audit/        rules (one file per rule), estimator
    plan/         Plan types, builder, serializer
    execute/      queue, worker pool, progress events
    engines/      image, svg, video
    ffmpeg/       binary resolution, capability detection, OS install hints
    manifest/     read/write manifest, hash cache, stale/orphan detection
    snippets/     <picture>, srcset, <video> generation (HTML + JSX)
    config/       loader, schema (zod), defaults, writer (for "save choices")
    fs-safe.ts
test/
  fixtures/       tiny media files (see §8)
  unit/  integration/  golden/
```

---

## 4. Key formats (summary — keep in sync with code)

### Output layout
```
<outDir>/<mirrored source dir>/<basename>/<basename>-<width>.<ext>
<outDir>/bytecut-manifest.json
<outDir>/.bytecut-cache/        # analysis + estimate cache; ignores itself, never committed
```
Defaults: `outDir = public/_bytecut`, `publicPath = /_bytecut`, adjusted by detected framework.
The mirrored dir is relative to the **static root** (`public` for Next/Astro/Vite and for static sites
that have one), so `public/img/hero.jpg` → `<outDir>/img/hero/hero-1920.jpg`, served at
`/_bytecut/img/hero/hero-1920.jpg`. Sources outside the static root mirror from the project root.
A static site with no `public/` uses `outDir = _bytecut` and static root `.`.

Videos (and animated GIFs) mirror the same way, one folder per source:
```
<outDir>/<dir>/<basename>/<basename>-<width>.av1.mp4
<outDir>/<dir>/<basename>/<basename>-<width>.h264.mp4
<outDir>/<dir>/<basename>/<basename>-poster.avif
```
`<width>` is the output width after the preset's cap (even, never upscaled).

### Config (optional) — `bytecut.config.ts` / `.json` / `.toml`
Fields: `include`, `exclude`, `outDir`, `publicPath`, `framework`, `assets` (glob → preset, first
match wins), `presets` (with `extends`), `audit.rules` (ESLint-style `[severity, options]`),
`audit.ignore`, `budgets`, `manifest.placeholder`, `concurrency`, `ffmpegPath`, `ffprobePath`, `ssimulacra2Path` (M9). Validate with zod. Missing
config must behave exactly like zero-config.

As implemented (`src/core/config/`): the file is `bytecut.config.{ts,mts,js,mjs,json,toml}` in the
project root (or `--config`); the schema is strict, so unknown keys are errors. `assets` maps globs
to preset names (first match wins; a pattern without `/` matches the name at any depth). `presets`
entries say what they `extends` (a built-in name without `extends` changes that built-in) and may set
`target`, `widths` or `maxEdge` (the longest side; not both), `formats`, `quality`, `effort`, `lossless`, `priority` (images) or `audio`,
`maxWidth`, `maxFps`, `codecs`, `crf` (video). `budgets` takes `maxFileSize` / `maxTotalSize` as bytes
or `"250 KB"`. `raw` is rejected. On image presets `ssimulacra2` (lowest acceptable score), `maxSize` (cap per
output) and `floor` (lowest score while fitting the cap; required with `maxSize`) turn on a perceptual
quality search; on video presets `ssimulacra2` or `vmaf` (one per preset) search the CRF on sampled
clips; `ssimulacra2Path` is an optional native scorer.

### Presets
Built-ins: `photo`, `hero`, `icon`, `svg`, `background-video`, `content-video`, `gif-to-video`.
Image presets write one JPEG per image by default (longest side up to 1920); `webp` and `avif` are
opt-in through `formats`, and a source with real transparency (or a lossless/icon preset, or a PNG the
classifier could not place) gets a lossless PNG in place of the JPEG.
Quality is intent (`target: "low" | "balanced" | "high" | "lossless"`), optionally with a perceptual
threshold (`ssimulacra2`, `vmaf`) or a `raw` encoder escape hatch. Precedence (low → high):
built-in → `extends` chain → `assets` match → per-file override (TUI/flags).

### Audit rules
One file per rule under `src/core/audit/rules/`. Each exports `{ id, category, defaultSeverity, check(ctx), fix }`.
Severities: `error` (fails `check`), `warn` (selected by default), `info` (unselected), `off`.
Initial rule ids: `image/no-modern-format`, `image/oversized-dimensions`, `image/heavy`,
`image/photo-as-png`, `image/reencode-savings`, `image/metadata`, `image/no-responsive-set`,
`image/cmyk-or-16bit`, `svg/unminified`, `svg/embedded-raster`, `gif/animated`, `gif/static`,
`video/no-modern-codec`, `video/no-fallback`, `video/oversized-resolution`, `video/high-fps`,
`video/high-bitrate`, `video/audio-in-background`, `video/no-faststart`, `video/no-poster`,
`project/stale-output`, `project/orphaned-output`, `project/duplicate`, `project/unreferenced`,
`project/over-budget`.

### Manifest
Maps each source (relative path + sha256) to its outputs (path, url, format, width, height, bytes),
preset used, and optional placeholder. It is also the cache: unchanged hash + same resolved preset = skip.
Include a `version` field; bump it on breaking changes. Also record the tool versions and the encoders
actually used per output (e.g. `libsvtav1`, `libx264`, whether VMAF search ran).

As implemented (`src/core/manifest/types.ts`; version 3 adds `videos`, and version 2 is still read): `{ version, tools, publicPath, sources }`; each
source has `sha256, bytes, width, height, preset, outputs[]`; each output has `path, url, format, width,
height, bytes, sha256?, lossless, quality, effort, encoder, status` where `status` is `written`,
`already-optimal` (no file, no sha256) or `stale`. Keys are sorted and there are no timestamps, so an
unchanged run leaves the file byte-identical. Sources and videos may also carry `priority` (an LCP candidate: snippets emit `fetchpriority="high"`
and no lazy loading) and a `placeholder` (`dominant-color`, `lqip` or `blurhash`); video outputs carry
`codecs`, the exact RFC 6381 string read from the file. All three are optional and additive. Image outputs found by a perceptual search also carry `search` (target, floor, size cap, and `plannedPath` when the width was stepped down), `score` and `scorer`; video outputs carry `search` (`metric`, `target`), `score` and `scorer` (`wasm`, `native` or `libvmaf`).
`outputs` lists everything bytecut owns for that source,
including orphans, which is what makes them deletable under §6.3.

### ffmpeg sourcing
bytecut does **not** bundle or download ffmpeg. It uses the user's own install.
- **Resolution order:** `--ffmpeg <path>` flag → `BYTECUT_FFMPEG` env var → `ffmpegPath` in config → `PATH`.
  `ffprobe` is resolved the same way (`--ffprobe`, `BYTECUT_FFPROBE`, `ffprobePath`), defaulting to the
  directory of the resolved ffmpeg, then `PATH`.
- **Capability detection** (cached per binary path + version): parse `ffmpeg -encoders` and `-filters` for
  `libsvtav1`, `libaom-av1`, `libx264`, `libvpx-vp9`, `libvmaf`.
- **Graceful degradation** (never fail the whole run):
  - No ffmpeg: images work fully. Video files and GIFs still appear in the audit, marked "needs ffmpeg"
    with the install command for the user's OS (`brew install ffmpeg`, `apt install ffmpeg`,
    `winget install ffmpeg`, etc.). Never skip them silently.
  - No AV1 encoder: still produce the H.264 output and poster; warn that AV1 was skipped.
    Prefer `libsvtav1`, fall back to `libaom-av1`.
  - No `libvmaf`: use fixed quality settings from the preset's `target` and skip the VMAF search; say so.
- When a later run finds better encoders than the manifest recorded, `project/stale-output` offers to regenerate.
- A possible later opt-in: `bytecut doctor --install-ffmpeg` that asks first and downloads into a cache dir.
  Out of scope until after M9.

---

## 5. Milestones

Work **one milestone at a time, in order**. Each milestone ends with its acceptance criteria passing,
tests green, and the progress log (§10) updated. Do not start the next milestone in the same change.

### M0 — Scaffold
- pnpm project, TS strict, ESM, tsup build, vitest, lint/format, `bin: { bytecut }`.
- `bytecut --version`, `bytecut --help`.
- `bytecut doctor`: reports Node version, sharp availability, which ffmpeg/ffprobe was resolved and from where (flag/env/config/PATH), their versions, available encoders (libsvtav1/libaom-av1, libx264, libvpx-vp9), libvmaf availability, and what will be degraded. If ffmpeg is missing, prints the install command for the current OS.
- ffmpeg resolution + capability detection module (`src/core/ffmpeg/`) per §4 "ffmpeg sourcing".
- CI workflow running lint, typecheck, tests on Linux + macOS (+ Windows if feasible).

**Done when:** `pnpm build && node dist/cli.js doctor` prints a correct report; unit tests cover the resolution order and capability parsing (using recorded `ffmpeg -encoders` output, not a live binary); CI green.

### M1 — Image engine + headless optimize
- `bytecut optimize <paths...> -y` for raster images using the `photo` preset: AVIF + WebP at default widths, never upscale, strip metadata but keep ICC profile.
- Writes to `outDir` with the mirrored layout. Sources untouched.
- Summary table: per file and total bytes before/after.

**Done when:** running on `test/fixtures/images` produces the expected files; integration test asserts layout, dimensions, formats, and that source hashes are unchanged.

### M2 — Plan, manifest, cache
- Plan type + builder; `--dry-run` prints the plan; `--json` emits it; `--plan <file>` executes a saved plan.
- Manifest written after each run; re-running skips unchanged files.
- `project/stale-output` and `project/orphaned-output` detection (reporting only for now).

**Done when:** second run on unchanged fixtures does zero encodes; touching one fixture re-encodes only that file; dry-run output is a stable golden snapshot.

### M3 — Scanner, framework detection, classifier, audit
- Detect Next.js / Astro / Vite / static; derive default include paths, `outDir`, `publicPath`.
- Classifier assigns built-in presets via heuristics (photo vs icon via color count/alpha, hero via size/name, etc.).
- Audit engine + image/SVG/GIF/project rules. Savings estimator (downscaled trial encode, cached by hash).
- `bytecut audit` (headless) prints issues grouped by rule with estimated savings.

**Done when:** audit on a fixture project lists the expected rule hits (golden test); estimator is within ±25% of actual on fixtures; audit on a 200-file fixture set completes in under 10s on a warm cache.

### M4 — TUI
- `bytecut` (no args, TTY) opens the Ink app: header (framework, scan paths, outDir), audit list with checkboxes, plan review, live progress, results log, status line.
- Command bar with `/` slash command palette and `@` fuzzy file mentions.
- Keybindings: space toggle, enter review/run, `p` change preset, `o` change outDir, `d` details, esc cancel, `?` help.
- Cancelling mid-run leaves no partial files (see §6).
- Non-TTY or `CI=true` falls back to headless behavior automatically.

**Done when:** manual walkthrough of the full flow works; component tests (ink-testing-library) cover list selection, plan review, and cancel.

### M5 — Video
- ffprobe-based probing; presets `background-video`, `content-video`, `gif-to-video`.
- AV1 + H.264 MP4 outputs, `+faststart`, audio strip when preset says so, poster extraction (AVIF), resolution/fps caps.
- Progress parsed from ffmpeg `-progress pipe:1`; separate concurrency limit (default 1).
- Video audit rules. Hardware encoders are **not** used by default (quality varies); allow opt-in later.
- Degradation paths from §4 "ffmpeg sourcing": no ffmpeg, no AV1 encoder, no libvmaf. Each is reported in the TUI and headless summary.
- Manifest records the encoders used per output.

**Done when:** fixture videos produce expected outputs; `ffprobe` on outputs confirms codec, dimensions, faststart, and audio presence/absence; cancel kills ffmpeg and cleans up; each degradation path is tested (simulate via fake capability sets / a missing binary path) and produces the documented warnings and outputs.

### M6 — Web outputs
- Snippet generation: `<picture>`/`srcset`/`sizes` and `<video>` with sources + poster, in HTML and JSX (chosen by framework). Copy to clipboard from TUI; `bytecut snippet <file>` headless.
- Placeholders in manifest: blurhash / LQIP / dominant color.
- `priority` presets emit `fetchpriority="high"` and no `loading="lazy"`.

**Done when:** golden tests for snippets across frameworks; generated JSX type-checks in a sample React file.

### M7 — Config
- Loader for `.ts`/`.json`/`.toml`, zod schema with readable errors, defaults merge.
- `bytecut explain <file>` shows the matched rule and fully resolved preset.
- `bytecut init` and the TUI "save these choices?" prompt write a **minimal** config containing only non-default values.
- `init` never adds `outDir` to `.gitignore`. If `outDir` is already gitignored, `init` and `doctor` point it out (since outputs are meant to be committed) but change nothing.

**Done when:** config fixtures cover precedence rules; round-trip test (TUI choices → written config → identical plan).

### M8 — CI mode
- `bytecut check`: runs audit, exits non-zero on any `error` (including `project/over-budget`).
- `--changed [base]` limits to files changed vs a git ref.
- `--report md|json` for PR comments.

**Done when:** exit codes are tested; `--changed` tested in a temp git repo.

### M9 — Quality targets & compare (stretch)
- Perceptual target search: binary-search encoder quality to the smallest output meeting `ssimulacra2` / `vmaf`, using sampled clips for video.
- SSIMULACRA2 via **WASM**: compile the Rust crate `rust-av/ssimulacra2` to WASM and publish it as a separate package we own (e.g. `bytecut-ssimulacra2`). Verify the crate's license before vendoring.
  - Load it lazily, only when a quality search runs.
  - Search on a representative crop (~512px) to pick encoder quality, then score the full-size output once to confirm it meets the target.
  - Run scoring in worker threads.
  - Optional speed-up: a native `ssimulacra2` binary, resolved like ffmpeg (`--ssimulacra2` flag → `BYTECUT_SSIMULACRA2` env → `ssimulacra2Path` config → `PATH`). WASM remains the default and the fallback.
  - Do not use the existing `ssimulacra2-js` npm package (its README reports incorrect results from the JS version; unmaintained since 2022; no license).
- `maxSize` conflict resolution: lower quality to floor → step down resolution → report failure.
- `/compare`: local before/after slider page served on localhost.

**Done when:** WASM SSIMULACRA2 scores match the reference C++ tool (libjxl / cloudinary `ssimulacra2`) within a small tolerance on fixture pairs (record the reference scores as golden values); crop-based search picks a quality whose full-size output meets the target on fixtures; search works with no native binary present.

---

## 6. Guardrails

These are hard rules. If a task seems to require breaking one, stop and ask.

### Data safety
1. **Never modify, move, rename or delete a source file.** Sources are read-only. Enforce in `fs-safe.ts`, not by convention.
2. **Only write inside `outDir`** (plus the config file, and only via `init` / explicit "save"). `fs-safe.ts` must resolve real paths and reject anything outside `outDir`, including via `..` or symlinks.
3. **Only delete inside `outDir`, and only files listed in the manifest** (e.g. orphaned outputs), and only after user confirmation (TUI) or an explicit flag (`--prune`) in headless mode.
4. **Atomic writes:** write to a temp file in the same directory, then rename. A cancelled or crashed run must never leave a truncated output that looks valid.
5. Refuse to run if `outDir` resolves to the project root, a source folder itself, or a path containing sources that aren't already bytecut outputs.
6. Never overwrite an output whose manifest entry doesn't match (someone hand-edited it) without warning.

### Output quality
7. **Never upscale.** Never output a file larger than the best existing equivalent; if optimization doesn't help, skip and report "already optimal".
8. Conservative heuristics: when unsure, keep audio, keep resolution, use lossless for ambiguous PNGs, keep color profiles.
9. Preserve orientation (apply EXIF rotation before stripping metadata) and alpha channels.
10. Always strip GPS metadata from outputs.

### Behavior
11. **No network access at runtime.** No telemetry, no update checks, no downloads. (sharp's install-time binaries are the only exception.) Do not add an ffmpeg-bundling dependency.
12. Deterministic outputs: same input + same resolved preset + same tool versions = byte-identical output where the encoder allows. Record tool versions in the manifest.
13. Headless mode never prompts. Without `-y`, headless destructive or bulk actions print the plan and exit 0.
14. Spawn ffmpeg with an argument array, never a shell string. Never interpolate file names into shell commands.
15. Respect `.gitignore` and `exclude` when scanning; never descend into `node_modules`, `.git`, or `outDir`.

### Engineering
16. `src/core` has no dependency on `src/tui`.
17. Every audit rule and every preset has tests.
18. Don't add dependencies, change settled decisions (§1), or change on-disk formats (manifest, config schema, output layout) without asking.
19. Keep the TUI responsive: heavy work runs off the render path (worker threads or child processes) and reports progress via events.

---

## 7. Coding conventions

- TypeScript strict; no `any` except at clearly-commented boundaries. Prefer `unknown` + zod.
- Pure functions in `core` wherever possible; I/O at the edges.
- Errors: throw typed errors (`BytecutError` with a `code`); the CLI layer formats them. No stack traces for expected user errors.
- Sizes in bytes internally; format only for display. Parse human sizes (`"250 KB"`) in the config layer.
- Paths: store POSIX-style relative paths in plans and manifest; convert at the fs boundary. Must work on Windows.
- Small files, one responsibility each. One audit rule per file.
- Comments explain *why*, not *what*.

---

## 8. Testing

- **Fixtures are tiny**: images ≤ 200 KB, videos ≤ 3 s and ≤ 1 MB each. Generate synthetic ones with a script (`scripts/make-fixtures.ts` using sharp/ffmpeg) rather than committing large binaries. Include: photo JPEG, photo-as-PNG, flat-color PNG with alpha, CMYK JPEG, 16-bit PNG, rotated-EXIF JPEG, GPS-tagged JPEG, oversized image, animated GIF, static GIF, minified + unminified SVG, SVG with embedded raster, video with audio, silent video, 60fps video, non-faststart MP4.
- **Unit:** classifier, preset resolution, each audit rule, snippet generation, fs-safe path checks.
- **Integration:** run commands against a temp copy of a fixture project; assert outputs via sharp metadata / ffprobe, never by eyeballing.
- **Golden:** dry-run plans, audit reports, snippets. Update goldens only intentionally.
- **Guardrail tests are mandatory:** attempts to write outside outDir, symlink escapes, cancel mid-encode, source hashes unchanged after every integration test.
- Tests requiring ffmpeg are skipped (with a visible notice) when ffmpeg is absent, but CI must have it.

---

## 9. Commands

```
pnpm install
pnpm dev            # run CLI from source (tsx)
pnpm build
pnpm test           # vitest
pnpm test:watch
pnpm lint
pnpm typecheck
pnpm fixtures       # regenerate test fixtures
```
Keep this list accurate as scripts change.

---

## 10. Agent workflow

1. Read this file and `PROGRESS.md` (create it in M0) before starting.
2. For anything beyond a small fix, **write a short plan first** (files to touch, approach, tests) and confirm it.
3. Implement the smallest change that satisfies the current milestone's acceptance criteria.
4. Run `pnpm typecheck && pnpm lint && pnpm test` before declaring anything done. Report actual results, not expected ones.
5. Update `PROGRESS.md`: milestone status, what changed, decisions made, known issues, next step.
6. If you make a decision this file doesn't cover (library choice, format detail), record it in the "Decisions log" below in one line.
7. Never mark a milestone complete with failing or skipped tests that should run.

### When to stop and ask
- A guardrail would need to bend.
- An on-disk format or a settled decision would change.
- A new dependency is needed.
- Acceptance criteria look wrong or contradictory.
- Encoder/ffmpeg behavior differs across platforms in a way that affects outputs.

---

## 11. Out of scope (for now)

- AI / natural-language input.
- GUI, Electron, or web app versions.
- Cloud processing, CDNs, uploading anywhere.
- Hardware video encoders by default (opt-in later).
- Build-tool plugins (Vite/Astro/Next) — the core is designed to allow them later.
- Audio-only files, fonts, PDFs.

---

## 12. Open questions

- Package name: `bytecut` (unclaimed on npm as of 2026-10-10). Reserve it early with a 0.0.1 placeholder publish.

---

## Decisions log
<!-- one line per decision: date — decision — reason -->
- 2026-10-10 — Project name is `bytecut` — `squeeze` was taken on npm.
- 2026-10-10 — Use the user's own ffmpeg, don't bundle — keeps `npx` fast for image-only users, avoids a postinstall download and GPL redistribution, and bundled builds don't guarantee libsvtav1/libvmaf anyway.
- 2026-10-10 — SSIMULACRA2 via our own WASM build of `rust-av/ssimulacra2`, native binary optional — works on every OS with no postinstall; the only JS port is inaccurate and unmaintained; a native-only approach repeats the ffmpeg install problem.
- 2026-10-10 — `outDir` is committed to git by default — deploys and CI don't need ffmpeg or re-encoding, and output changes are reviewable. Makes deterministic outputs (guardrail 12) important to avoid noisy diffs.
- 2026-10-10 — CLI parsing is `citty` — small, ESM-native, typed subcommands, lazy-loadable.
- 2026-10-10 — Lint/format is `eslint` (typescript-eslint flat config) + `prettier`.
- 2026-10-10 — TypeScript pinned to ~5.9 — typescript-eslint does not support TS 7.0 yet; revisit when it does.
- 2026-10-10 — An explicitly set ffmpeg path (flag/env/config) that doesn't exist is reported as not found and does not fall through to PATH — a typo must never silently pick a different binary.
- 2026-10-10 — `sharp` added as a runtime dependency in M0 (on the §2 list) so `doctor` can report its availability.
- 2026-10-10 — photo preset defaults: widths 640/1280/1920 (capped at source width; a narrower source gets one output at its native width), AVIF q60 + WebP q78, effort 4 — keeps output count low and git diffs small; quality values are first guesses until M3/M9.
- 2026-10-10 — PNG sources under `photo` get lossless WebP + lossy AVIF with alpha — conservative per §6.8 until the M3 classifier can tell flat art from photos.
- 2026-10-10 — "Already optimal" is decided per output file: any output not smaller than the source's bytes is not written (§6.7).
- 2026-10-10 — Two sources that would produce the same output path abort planning with `OUTPUT_COLLISION` rather than overwrite one another.
- 2026-10-10 — Manifest records the encoder (with library version) per output rather than one global tool list, and carries no timestamps — a cached output's encoder stays truthful, and the committed file only changes when outputs do.
- 2026-10-10 — An existing output that isn't in the manifest or no longer matches its hash is left alone with a warning; `--force` overwrites (guardrail 6). Byte-identical files already on disk are accepted without a write, so pre-manifest M1 outputs adopt cleanly.
- 2026-10-10 — `--force` re-encodes unchanged files as well as overwriting protected outputs — it is the only way to act on encoder drift until a targeted regenerate exists.
- 2026-10-10 — `project/stale-output` is `warn` and `project/orphaned-output` is `info` (deleting is destructive, so unselected by default); both are reporting-only in M2.
- 2026-10-10 — A saved plan re-checks each source's sha256 at execution time and fails that file if it changed — a plan is a statement about specific bytes.
- 2026-10-10 — Expected user errors are caught per command (`guarded`) and printed as one line, because citty's `runMain` prints a stack for anything thrown.
- 2026-10-10 — Output paths mirror relative to the static root (not the cwd) and the manifest is version 2; a v1 manifest is refused rather than migrated — bytecut is unpublished, and URLs now parallel how the original assets are served.
- 2026-10-10 — Added `ignore` (npm) for .gitignore semantics (guardrail 15) — hand-rolling negation/anchoring risks silently scanning files the user excluded. `svgo` (already on the list) added for SVG estimates.
- 2026-10-10 — Analysis and estimate cache lives in `<outDir>/.bytecut-cache/` with a self-ignoring `.gitignore`, written by `audit` and `optimize -y` but not by dry runs or `--no-cache` — satisfies §6.2 while staying out of commits; a corrupt cache is a cold start.
- 2026-10-10 — Size estimates use a real trial encode at ≤640px scaled by width^1.6 — a per-image exponent fit was worse on fixtures (41% vs 16% worst case); the constant is a prior and is documented as one.
- 2026-10-10 — Source-level audit rules (legacy format, oversized, heavy, metadata, ...) skip images whose outputs are up to date, since sources are never modified but served files are; a finished project audits clean.
- 2026-10-10 — The classifier falls back to `photo` when ambiguous, and `icon` is capped at 1024px so wide flat art isn't limited to icon widths — conservative per §6.8.
- 2026-10-10 — `optimize`'s headline compares source to the widest output per image (same measure as `audit`), not to the sum of all generated widths and formats.
- 2026-10-10 — `image/no-responsive-set`, `image/no-modern-format` and others may all fire on one unoptimized file; per-rule sections keep their own numbers and the summary counts each file's best saving once.
- 2026-10-10 — The TUI lists one row per optimizable file; findings `optimize` cannot fix (SVG, duplicates, animated GIFs, unreferenced, over-budget, orphaned) are shown in a separate report-only section so they are never silently dropped (§4).
- 2026-10-10 — Plain `bytecut` without a TTY (or with CI set) prints the audit report and a hint and writes nothing, not even the analysis cache — a bare `npx bytecut` in CI must not touch the repo (§6.13).
- 2026-10-10 — Rules carry `fix: "optimize" | null`; the TUI only offers selection for findings whose fix is `optimize`, so adding a fixer to a rule is what makes it actionable.
- 2026-10-10 — Per-file preset overrides are TUI session state, passed to both the audit and the optimizer so an optimized file does not reappear as work to do; persisting them is the M7 save prompt.
- 2026-10-10 — Esc during a run aborts and finishes the in-flight encode (sharp cannot be interrupted); atomic writes mean no partial file is left, and the manifest records only what was fully written.
- 2026-10-10 — Added `react` (Ink's required peer), `@types/react` and `ink-testing-library` (dev) for M4, with your approval; `ink` was already on the §2 list.
- 2026-10-10 — Manifest is version 3 and still reads version 2 (additive `videos` map) — a v2 manifest loses nothing, so forcing a delete-and-regenerate would only cost users encoding time.
- 2026-10-10 — Video lives in separate `plan.videos` / `manifest.videos` collections rather than a tagged union of outputs — image code and its tests stay untouched, and video's different parameters (codec, crf, caps, audio) get precise types.
- 2026-10-10 — Plans never depend on which encoders are installed; availability is decided and reported when a plan runs — a saved plan means the same thing on every machine, and `--dry-run --json` output stays stable.
- 2026-10-10 — Default AV1 speed is SVT-AV1 preset 6 and quality is a fixed CRF per preset (confirmed with you) — outputs are committed and cached by hash, so encode time is paid once; the perceptual search is M9.
- 2026-10-10 — Audit estimates video savings by default with real sample encodes cached by content hash (confirmed with you); a clip of at most four seconds is encoded whole and so is exact.
- 2026-10-10 — ffmpeg writes only to temp paths reserved by `SafeFs` and published atomically; sampling writes nothing (raw stream on stdout) — keeps §3's "all writes go through one module" true with a child process doing the writing.
- 2026-10-10 — Background-video is chosen only on evidence (no audio on a short clip, or a backdrop-like name on a short clip) — removing audio is the one irreversible change, so doubt keeps it (§6.8).
- 2026-10-10 — An output whose encoder is unavailable is reported as skipped and does not count as a cache miss — otherwise the other codec would be re-encoded on every run.
- 2026-10-10 — Snippets are generated from the manifest alone (no encoding), as one element tree rendered to HTML or JSX; the format follows the framework (Next and Vite+React → JSX, otherwise HTML) — keeps the two syntaxes from drifting and makes `snippet` instant.
- 2026-10-10 — `<img src>` inside `<picture>` is the largest WebP, not the original (confirmed with you) — every browser that understands <picture> supports WebP, so even the fallback path serves optimized bytes.
- 2026-10-10 — Video `<source>` elements carry exact codec strings read from the MP4's own `avcC`/`av1C` boxes, AV1 first — without a codecs parameter a browser that cannot decode AV1 still selects the AV1 source and never tries the fallback.
- 2026-10-10 — The default placeholder is a dominant colour (confirmed with you); LQIP and BlurHash are opt-in with `--placeholder` — 7 characters per file keeps the committed manifest small and its diffs quiet.
- 2026-10-10 — BlurHash is implemented in-house and uses the largest ABSOLUTE AC value as the algorithm text specifies, deviating from `blurhash@2.0.5` (signed maximum) — measured ~4x lower error on dark-to-light gradients; chosen with you after seeing the numbers. Verified against the reference on recorded vectors, with the package's own output pinned.
- 2026-10-10 — `hero` is the only `priority` preset; priority is stored in the manifest, and `--priority`/`--lazy` override it per snippet — so custom presets later cannot silently lose it.
- 2026-10-10 — Generated JSX is type-checked with the real compiler in tests, with negative controls — attribute casing (`fetchPriority`, `srcSet`, `playsInline`) is exactly what hand-written generators get wrong.
- 2026-10-10 — The TUI copies with a native tool, then OSC 52, and always shows the markup — no dependency, works over SSH, and a failed copy is never a dead end.
- 2026-10-10 — `.ts` configs are loaded with Node's own type stripping, no loader dependency (confirmed with you) — keeps §2's dependency list short; older 22.x gets a clear error for `.ts` only and JSON/TOML still work.
- 2026-10-10 — Added `smol-toml` for TOML configs (confirmed with you) — Node has no TOML parser and hand-rolling one is a worse risk than a small zero-dependency package.
- 2026-10-10 — `init` and the TUI save write `bytecut.config.json`; a TS or TOML config is never rewritten, the lines to add are shown instead (confirmed with you) — a rewrite would drop comments or mangle code the user owns.
- 2026-10-10 — `ssimulacra2`, `vmaf`, `raw` and `ssimulacra2Path` fail validation with "arrives in M9" (confirmed with you) — no schema is promised ahead of its engine and nothing is silently accepted-and-ignored. `target` maps to fixed quality: AVIF 45/60/75, WebP 65/78/88, video CRF +4/0/-4.
- 2026-10-10 — Precedence is classifier < `assets` (first match) < `--preset` < per-file choice, and flags > config > detection for folders, placeholder and ffmpeg paths — matches §4 and means a saved choice and the choice made in the session produce the same executable plan.
- 2026-10-10 — The config file is the one write outside `outDir`; `writeConfigFile` in `fs-safe.ts` accepts only the known config names in the project root, refuses symlinks and is atomic — keeps §3's single write module and §6.2 true.
- 2026-10-10 — A built-in preset name defined in the config without `extends` changes that built-in, so the classifier's verdicts and every `extends` chain see the change — the natural reading of "make `photo` use these widths".
- 2026-10-10 — A saved per-file preset is an exact, glob-escaped path placed before existing `assets` rules (first match wins), and a declined save question is not repeated for the same choices in a session.
- 2026-10-10 — `check` exits 1 when findings fail and 2 when it could not run (confirmed with you) — CI must be able to tell "fix your images" from "fix your pipeline"; other commands keep exit 1 for BytecutError.
- 2026-10-10 — `--changed` audits the whole project and filters the report to changed files (confirmed with you) — total budget, duplicates and unreferenced stay correct; findings that name no file always count, and a changed bytecut config widens scope to everything.
- 2026-10-10 — `check --fail-on error|warn` is added beyond the milestone text (confirmed with you) — zero-config CI could otherwise never fail, since only `project/over-budget` defaults to `error`.
- 2026-10-10 — `--changed` defaults to `HEAD` (local changes) and is measured from the merge-base; it reads only local git data and never fetches (§6.11), failing with the fix for a shallow clone — predictable on every CI provider.
- 2026-10-10 — `check --report md|json` writes to stdout only and there is no output-file flag — §6.2 permits writes only in `outDir` and the config, so CI redirects.
- 2026-10-10 — SSIMULACRA2 ships as a pnpm workspace package `bytecut-ssimulacra2` with a committed prebuilt `.wasm` (confirmed with you) — the spec's "separate package we own", with no Rust needed to install, test or run CI.
- 2026-10-10 — The WASM build matches the reference C++ tool within 0.032 on 16 recorded pairs and the test tolerance is 0.1 — measured against libjxl `tools/ssimulacra2` (commit ef67fde), not asserted; rayon is off and worker threads provide parallelism.
- 2026-10-10 — A named native scorer path that is missing falls back to the built-in WASM scorer with a note, and never to PATH — a typo must not silently pick a different binary (as with ffmpeg), while the scorer can always fall back because WASM is always there.
- 2026-10-10 — Native scorer inputs are written as temp files inside `outDir` through `SafeFs.writeTemp` and removed after each score — keeps §3's single write module true for a child process that reads files.
- 2026-10-10 — Perceptual search is described by the plan (`search` on an output) and recorded in the manifest (`search`, `score`, `scorer`), all optional and additive (confirmed with you) — cache validity compares the parameters, not the quality the search landed on.
- 2026-10-10 — A width stepped down to fit `maxSize` is named by its real width and the manifest records the planned path (confirmed with you) — the file name never lies about its pixels, and the cache and orphan rules still recognise it.
- 2026-10-10 — `floor` is required whenever `maxSize` is set (confirmed with you) — how far quality may fall is a tradeoff the config must state; no default can silently degrade images.
- 2026-10-10 — The search samples the median-detail 512 px tile and then proves the answer on the full-size output — the busiest tile over-spends on flat images and the flattest under-spends on textured ones; the full-size score is the one that counts.
- 2026-10-10 — Stepping down never goes below half the planned width or the next smaller planned width, and an unmet constraint fails the item (exit 1) without writing — a picture half as wide is not the one that was asked for, and a configured limit that is silently exceeded is worse than a reported failure.
- 2026-10-11 — Video quality search encodes sampled clips in memory (Matroska on stdout, decoded back through a pipe) and writes no file — keeps §3's single write module and leaves nothing to clean up on cancel.
- 2026-10-11 — A CRF's score is its worst sampled clip, and an unreachable video target fails the item without writing (confirmed with you) — one hard scene is what a viewer notices, and a configured target silently missed is worse than a reported failure.
- 2026-10-11 — `vmaf` uses ffmpeg's own `libvmaf` and, without it, falls back to the fixed CRF with a warning and records `search` without a `score` (per §4's "no libvmaf" rule) — the output still caches, and is searched once the filter exists.
- 2026-10-11 — The same scorer selection serves images and video (confirmed with you) — one flag, one lazy start, native when present and WASM otherwise.
- 2026-10-11 — `/compare` is a loopback-only read-only server with an unguessable path token, index-addressed files and a Host check, serving one self-contained page (confirmed with you: images and video) — it cannot be reached from another machine or a web page, and a request can never name a path.
- 2026-10-11 — The scorer package is the unscoped `bytecut-ssimulacra2`, not `@bytecut/ssimulacra2` (confirmed with you) — the `@bytecut` npm scope is owned by someone else, and an unscoped name needs no organisation.
- 2026-10-11 — `photo` and `hero` make one output per format with the longest side capped at 1920 (a landscape image 1920 wide, a portrait one 1920 tall with the width in proportion, rounded down; confirmed with you) — supersedes the 640/1280/1920 set; files are named by their real width, an image already within the cap keeps its size, and `widths` remains for anyone who wants a set.
- 2026-10-11 — Added the preset field `maxEdge` (longest side) beside `widths`, mutually exclusive — without it a configured size could only be a width, which is the wrong cap for portrait images.
- 2026-10-11 — The size estimator trial-encodes at 640 px even when the only planned output is wider, and extrapolates — otherwise the single 1920 default would make an audit encode every image at full size.
- 2026-10-11 — The default image output is a single JPEG (mozjpeg); WebP and AVIF are opt-in via `formats` (confirmed with you) — supersedes the AVIF + WebP default of M1, and the JPEG is the file every browser and tool can open. Video posters stay AVIF.
- 2026-10-11 — Where the preset asks for `jpg` but the source has real transparency, or the preset is lossless, or a PNG's content is ambiguous, the output is a lossless PNG instead (confirmed with you) — keeps §6.9 (alpha) and §6.8 (ambiguous PNGs stay lossless); `icon` writes PNG.
- 2026-10-11 — `ImageFormat` is now `jpg | png | webp | avif`, and manifests and plans accept all four — additive: an older manifest of avif/webp still reads.

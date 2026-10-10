# PROGRESS

## Status

| Milestone                           | Status                           |
| ----------------------------------- | -------------------------------- |
| M0 Scaffold                         | Complete locally; CI not yet run |
| M1 Image engine + headless optimize | Complete locally; CI not yet run |
| M2 Plan, manifest, cache            | Complete locally; CI not yet run |
| M3 Scanner, classifier, audit       | Complete locally; CI not yet run |
| M4 TUI                              | Complete locally; CI not yet run |
| M5 Video                            | Complete locally; CI not yet run |
| M6 – M9                             | Not started                      |

## M0 — what changed

- pnpm project: TS strict, ESM, tsup bundle to `dist/cli.js` (shebang, `bin: bytecut`), vitest, eslint + prettier.
- `bytecut --version`, `bytecut --help` (citty).
- `bytecut doctor [--ffmpeg <p>] [--ffprobe <p>] [--json]`: Node, sharp, resolved ffmpeg/ffprobe with
  source (flag/env/config/ffmpeg-dir/PATH) and version, AV1/H.264/VP9/libvmaf, and a "Degraded" list with
  the OS install command when ffmpeg is missing. Exits 1 only if Node < 22 or sharp cannot load.
- `src/core/ffmpeg/`: resolution order, capability parsing (cached per path + version, AV1 encoder
  preference), install hints. An explicit path that doesn't exist is reported, not silently replaced.
- `.github/workflows/ci.yml`: lint, typecheck, test, build, doctor on ubuntu/macos/windows with ffmpeg.
- Capability tests use output recorded from ffmpeg 6.1.1 (`test/fixtures/ffmpeg/`), not a live binary.
  `encoders-no-av1.txt` and `filters-with-vmaf.txt` are derived from that recording.

## M1 — what changed

- `bytecut optimize <paths...> [-y] [--out-dir <dir>]`: AVIF + WebP at 640/1280/1920 with the `photo`
  preset. Without `-y` it prints the plan and exits 0 (§6.13). Per-file and total before/after summary.
- `src/core/fs-safe.ts`: the only writer. Validates `outDir` (§6.5), rejects `..`/absolute/symlink escapes,
  refuses to write through a symlinked output, atomic temp-file + rename, cleans up temp on failure.
- `src/core/engines/`: `ImageEngine` interface + sharp implementation (EXIF rotation applied, metadata
  dropped, ICC kept, CMYK converted to sRGB instead of keeping its profile).
- `src/core/plan/`: `Plan` as plain JSON data + builder (never upscales, detects output collisions).
- `src/core/execute/run.ts`: bounded-concurrency executor, per-file failure isolation, AbortSignal cancel,
  skips any output not smaller than its source ("already optimal", §6.7).
- `src/core/scan/collect.ts`: directory walk skipping `node_modules`, `.git`, `outDir`; never follows symlinks.
- `scripts/make-fixtures.ts` (`pnpm fixtures`): deterministic synthetic images (photo, small, oversized,
  rotated-EXIF, GPS-tagged, P3-tagged, photo-as-PNG, flat PNG with alpha), all under 200 KB.
- Tests: 85 total (16 integration). Guardrail tests cover outDir validation, `..`/absolute paths, directory
  and file symlink escapes, no temp files on failure, cancel leaving no partials, source hashes unchanged.

### M1 verification and known issues

- Verified 2026-10-10: ran the built CLI on the fixtures (28 files written, dry run wrote nothing,
  rotated fixture came out 500x800 with no EXIF, GPS gone, P3 profile byte-identical to the source's).
- Encoder quality numbers (AVIF q60, WebP q78) are first guesses; M3's estimator and M9's quality search
  should replace them.
- GIF, SVG, CMYK and 16-bit PNG sources are not handled: unsupported explicit files are reported and
  skipped, and a corrupt image is listed as skipped in the plan. CMYK has code but no fixture or test.
- Output layout mirrors the cwd-relative path (`public/_bytecut/public/img/...`); see M2 known issues.

## M2 — what changed

- `optimize` gains `--dry-run`, `--json` (plan on stdout, dry-run only), `--plan <file>`, `--force`,
  `--public-path`. Without `-y` it still prints the plan and exits 0.
- **Plan** (additive change to M1's shape): items carry `sourceSha256`, the plan carries `publicPath`,
  items are sorted by POSIX path. It is independent of what is in `outDir`, so it is a stable golden.
  `--plan` input is validated with zod (no absolute or `..` paths), and each source's hash is re-checked
  at execution, so a saved plan is never applied to different bytes.
- **Manifest** `<outDir>/bytecut-manifest.json` (`src/core/manifest/`): version, informational tool
  versions, publicPath, and per source its sha256/bytes/dimensions/preset plus outputs (path, url,
  format, width, height, bytes, sha256, lossless, quality, effort, encoder + version, status). Sorted
  keys, trailing newline, no timestamps; written atomically via `fs-safe`, and only when content
  changed. Entries for sources outside the current scan are kept. A corrupt or newer-version manifest
  is a hard error.
- **Cache** (`manifest/cache.ts`): hit = same source hash + same planned outputs + every written output
  present with its recorded hash. A bare `touch` is a hit; a deleted or edited output is a miss.
- **Guardrail 6** (executor): an existing output is overwritten only if the manifest owns it and it is
  unmodified (or `--force`). Identical bytes already on disk are accepted without a write. Anything
  else is left alone with a warning and is not claimed by the manifest.
- **Audit rules** (`src/core/audit/`, one file per rule): `project/stale-output` (warn) and
  `project/orphaned-output` (info). Reporting only; nothing is deleted. Shown in a "Project" section.
- Cancel records only outputs that were fully written; interrupted files are cached as incomplete and
  finished on the next run. Outputs from an older source that a failed run didn't replace are marked
  `stale`, so the cache can never hit on them.
- CLI: expected user errors print one line (`bytecut: … [CODE]`) instead of a stack trace (§7).
- New dependency: `zod` (on the §2 list).

### M2 verification

- Acceptance: second run on unchanged fixtures does zero encodes (counted at the engine); changing one
  fixture re-encodes only that file; dry-run plan JSON and text are golden snapshots.
- Mutation-checked: making the cache never hit fails 6 tests; disabling the guardrail-6 check fails 2.

## M3 — what changed

- **Detection** (`src/core/scan/detect.ts`): Next.js / Astro / Vite from dependencies or config files
  (specific framework wins over `vite`), else static. Defaults: include `public`, outDir
  `public/_bytecut`, publicPath `/_bytecut`; a static site with no `public/` scans `.` into `_bytecut`.
  `optimize` and `audit` with no paths use these (the zero-config `npx bytecut` flow).
- **Output layout changed** (agreed): paths mirror relative to the static root, so
  `public/img/hero.jpg` → `<outDir>/img/hero/hero-640.avif`, served at `/_bytecut/img/hero/…`. Sources
  outside the static root mirror from the project root. **Manifest version 2**; a v1 manifest is
  refused with an instruction to delete the output folder.
- **Scanner**: real `.gitignore` semantics via the `ignore` package: nested files, negation,
  directory rules, and the project-root file applying when only a subfolder is scanned. Explicitly
  named files bypass it. Never follows symlinks. SVGs and videos are collected separately.
- **Classifier** (`src/core/classify/`): photo / hero / icon from colour count in a 64px sample,
  alpha actually used, size and file name. Ambiguity falls back to `photo` (§6.8), and every verdict
  carries a reason, shown in dry-run output. `--preset` forces one. `hero` and `icon` presets added.
- **Analysis** (`engines`): one decode yields dimensions, alpha use, colour count, colour space,
  bit depth and metadata sizes, including GPS via a bounds-checked EXIF IFD0 parser. Static GIFs are
  now processable; animated GIFs are skipped with a pointer to M5.
- **Estimator** (`audit/estimate.ts`): real trial encode at ≤640px, scaled to the largest planned width
  by `width^1.6`; cached by sha256 + preset params + encoder version.
- **Audit** (`audit/rules/`, one file per rule): `image/` no-modern-format, oversized-dimensions, heavy,
  photo-as-png, reencode-savings, metadata, no-responsive-set, cmyk-or-16bit; `svg/` unminified,
  embedded-raster; `gif/` animated, static; `project/` duplicate, unreferenced, over-budget, plus M2's
  stale-output and orphaned-output. ESLint-style severities and options (API only until M7).
  Source-level issues disappear once up-to-date outputs exist.
- **`bytecut audit [paths] [--json] [--all] [--no-cache]`**: grouped by rule with per-file estimates and a
  summary that counts each file's best saving once (rules overlap). Exit code 0 (`check` is M8).
- **Cache** `<outDir>/.bytecut-cache/` with a self-ignoring `.gitignore`: written by `audit` and by
  `optimize -y`, never by a dry run or `--no-cache`. A corrupt or mismatched cache is a cold start.
- **`optimize` summary** now states what it measures: files written (and their total across all widths)
  and "largest size per image: before → after", the same measure `audit` estimates. M1/M2 compared the
  source with the sum of every width and format, which read as a poor result.
- New dependencies: `ignore` (confirmed with you), `svgo` (on the §2 list).

## M4 — what changed

- **`bytecut` (no args)** opens an Ink UI when stdin and stdout are TTYs and `CI` is unset; otherwise it
  prints the audit report plus a hint, exit 0, writing nothing (not even the cache). Subcommands stay
  headless. The TUI is loaded lazily so `doctor`/`audit` don't pay for React.
- **Layout** (`src/tui/`, core never imports Ink): `state.ts` (pure reducer), `model.ts` (audit report →
  rows), `commands.ts` (command bar parser, `@` fuzzy matcher), `session.ts` (every core call the UI
  makes, injectable), `components/`, `app.tsx`.
- **List**: one row per optimizable file with checkbox, `size → ~estimate`, preset and rule badges,
  windowed to the terminal height. §4 defaults: warn+ selected, info not. Findings `optimize` cannot fix
  (SVG, duplicates, animated GIFs, unreferenced, over-budget, orphaned) sit in a separate report-only
  section. Files whose outputs are up to date drop out and are counted.
- **Keys**: `↑↓`/`jk`, `space`, `a`, `enter` (review, then run), `p` (cycle preset, `*` marks an override),
  `o` (output folder, validated with the same §6.5 checks as `optimize`), `d` (details), `?`, `esc`
  (back / cancel), `q`, `ctrl+c` (cancels a run first, quits only when idle).
- **Command bar**: `/audit /optimize [@files] /preset <name> [@files] /out <dir> /select all|none|warn
/doctor /help /quit`; `@` completes files by fuzzy match; a bare `@name` jumps the cursor. Pasted
  commands are handled as typing.
- **Review/run/cancel**: review shows the plan before anything is written; a live progress bar with
  per-output lines; Esc aborts, finishes the in-flight encode and leaves no partial files (atomic
  writes), and the results screen uses the same totals as the headless summary.
- **Core changes**: `audit()` returns per-file summaries and reports scan progress; `optimize()` accepts
  per-file preset overrides; the executor emits `onItemStart`/`onOutputDone`; rules carry a real `fix`
  marker (`"optimize"` or `null`) instead of an always-null placeholder.
- New dependencies (confirmed with you): `ink@8`, `react@19.3`, dev `@types/react`, `ink-testing-library`.

## M5 — what changed

- **Engine** (`src/core/video/`, behind a `VideoEngine` interface): `probe` via `ffprobe -of json`,
  `encode` with progress parsed from `-progress pipe:1` and cancellation (SIGTERM, then SIGKILL),
  `sampleBytes` (a short clip encoded to a raw stream on stdout, so estimates write no file) and
  `frame` (a PNG for the poster). Binary and capability resolution reuse M0 (`--ffmpeg`,
  `BYTECUT_FFMPEG`, PATH). Arguments are always an array (§6.14); a hostile file name stays one argv.
- **Writes stay in fs-safe**: ffmpeg writes a path it is given, so `SafeFs.reserveTemp/commitTemp/
discardTemp` hand it a validated temp path inside outDir and only publish it atomically.
- **Presets** `background-video` (silent, ≤1920 wide, ≤30 fps), `content-video` (keeps audio,
  resolution and fps) and `gif-to-video`; AV1 (SVT-AV1 preset 6) + H.264 MP4, `+faststart`,
  `yuv420p` with even dimensions, AVIF poster; fixed CRF per preset (the perceptual search is M9).
- **Classifier**: silent + short → background; a backdrop-like name on a short clip → background
  (and says its audio goes); anything else keeps its audio and resolution (§6.8).
- **Plan / manifest**: `plan.videos` and `manifest.videos` are additive collections, so image code is
  untouched. Manifest is **v3 and still reads v2**. The plan does not depend on installed encoders;
  availability is resolved when it runs and reported then.
- **Executor**: separate video lane (concurrency 1) beside the image lane; streaming hash for
  sources; per-output reuse so a cancelled or partly-failed run resumes without repeating minutes of
  encoding; §6.7 (never write larger than the source) and §6.6 (never overwrite what we don't own)
  apply to videos.
- **Degradation** (§4): no ffmpeg → listed as "needs ffmpeg" with the OS install command; no AV1
  encoder → H.264 + poster still produced and the skip reported (`libsvtav1` preferred, `libaom-av1`
  fallback); no `libvmaf` → fixed quality, and it says so. An AV1 output that can't be made does not
  make the cache miss every run.
- **Audit**: eight `video/*` rules; real sample-encode estimates cached by hash (a clip ≤4 s is
  encoded whole, so exact); `gif/animated` now has a real estimate; videos that need ffmpeg are
  listed by name. `stale-output`/`orphaned-output` cover videos, including encoder drift.
- **Animated GIFs** are lifted out of the image plan and converted as video.
- **CLI/TUI**: `optimize`/`audit` take `--ffmpeg/--ffprobe`; dry run prints video plans and
  degradation notes; the TUI lists videos, plans them, shows live percent, and skipped videos with
  what to install.

## Verification (2026-10-10, Linux, Node 23.8, ffmpeg 6.1.1)

- `pnpm typecheck`: pass. `pnpm lint`: pass. `pnpm build`: pass. `pnpm test`: 588 tests in 45 files (~110 s;
  M4 was ~100 s). One CPU-heavy integration test timed out at 30 s only under full-suite parallel load
  (it passes alone in ~12 s), so it now has a 120 s timeout; the run before that change was 587/588.
- **Real ffmpeg** (gated on its presence, with a visible skip notice): outputs verified with ffprobe
  for codec, dimensions, pixel format, frame rate, audio presence/absence and faststart (moov
  before mdat); AV1/H.264/poster byte-identical across two runs; a second run encodes nothing.
- **Cancel kills ffmpeg**: with a real slow encode, abort rejects within seconds, no process with
  the temp path remains (checked with `pgrep`), and no temp or partial file is left.
- **Degradation with real binaries**: a wrapper `ffmpeg` that hides the AV1 encoders yields H.264 +
  poster with the skip reported; a bad `--ffmpeg` path lists videos as needing ffmpeg while images
  still process.
- **Estimate accuracy**: an 8 s clip sampled at three points came within **11.6%** of the real AV1/
  H.264 output (one clip: thin evidence).
- Mutation-checked: writing larger-than-source outputs, leaving temp files, no per-output reuse,
  counting unavailable codecs as misses, skipping the ownership check, and not killing ffmpeg each
  fail the intended tests.

## Decisions

See "Decisions log" in AGENTS.md. M5 additions: manifest v3 reads v2; video as additive collections;
SVT-AV1 preset 6; estimates on by default and cached; capability-independent plans.

## Known issues

- **CRF values are first guesses** (AV1 32/36/38, H.264 23/26/28), as are the classifier's name tokens
  and the 45 s "short" limit. Bad guesses cost bytes or quality, not data.
- **The video estimate is one number from three 1.5 s samples**, a real encode but a thin sample of
  a long, varied video. Verified on a single clip. Estimates are labelled `~`.
- **Cold video audits are slow**: six tiny clips took ~11 s; a long 1080p library will take minutes.
  Results are cached by hash, and the TUI shows scan progress, not per-file names.
- **AV1 is roughly realtime at preset 6** on this machine (3 s of 640x360 in 2.8 s), so long videos
  take minutes. Cancelling is prompt (ffmpeg is killed), unlike the image engine.
- **Windows/macOS ffmpeg builds are untested**: the Windows runner's ffmpeg may lack `libsvtav1`;
  capability-gated tests should skip or degrade, but this has not run there.
- **The poster uses a frame at 10% of the duration**; no "best frame" detection, so it can be a
  blank frame for a video that fades in slowly.
- **HDR, rotation metadata, multiple audio tracks and subtitles are not handled specially**: the first
  video and first audio stream are used, and rotation relies on ffmpeg's default autorotate.
- **No VMAF search** (M9): `libvmaf` only changes the note, never the output.
- **Carried over**: SVG output still unimplemented; `--json` dry-run only; no `--prune`; no locking;
  `.gitignore` coverage partial; detection cwd-only; CI, macOS/Windows and a real SIGINT unverified.

## Next

M6 — web outputs: `<picture>`/`<video>` snippets (HTML and JSX), placeholders in the manifest
(blurhash/LQIP/dominant colour) and `priority` presets. Needs a confirmed plan first (§10).

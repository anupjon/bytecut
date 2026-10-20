# PROGRESS

## Status

| Milestone                           | Status                                           |
| ----------------------------------- | ------------------------------------------------ |
| M0 Scaffold                         | Complete locally; CI not yet run                 |
| M1 Image engine + headless optimize | Complete locally; CI not yet run                 |
| M2 Plan, manifest, cache            | Complete locally; CI not yet run                 |
| M3 Scanner, classifier, audit       | Complete locally; CI not yet run                 |
| M4 TUI                              | Complete locally; CI not yet run                 |
| M5 Video                            | Complete locally; CI not yet run                 |
| M6 Web outputs                      | Complete locally; CI not yet run                 |
| M7 Config                           | Complete locally; CI not yet run                 |
| M8 CI mode                          | Complete locally; CI not yet run                 |
| M9 Quality targets & compare        | Complete locally (3 of 3 stages); CI not yet run |

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

## M6 — what changed

- **`bytecut snippet <file…>`**: prints the `<picture>` or `<video>` markup for files that have been
  optimized, from the manifest only (no encoding). `--format html|jsx`, `--alt`, `--sizes`,
  `--class`, `--priority`, `--lazy`, `--json`. Markup alone goes to stdout; advice goes to stderr so
  the output pipes cleanly. A file that is not optimized yet fails with the exact command to run.
- **One element tree, two syntaxes** (`src/core/snippets/`): HTML and JSX cannot drift apart. JSX gets
  `className`, `srcSet`, `fetchPriority`, `playsInline`, `autoPlay`, self-closing tags and style
  objects; HTML keeps the lowercase spellings. Values are escaped; URLs are percent-encoded per segment.
- **Format follows the framework**: Next.js → JSX; Vite with `react` → JSX, otherwise HTML; Astro and
  static → HTML. `detectProject` now records whether `react` is a dependency.
- **Images**: AVIF and WebP `<source>`s with every width, explicit `sizes`, and an `<img>` whose
  `src` is the **largest WebP** (confirmed), with `width`/`height` so there is no layout shift.
  Priority presets (`hero`) emit `fetchpriority="high"` and no lazy loading.
- **Videos**: AV1 `<source>` first, then H.264, each with its **exact codec string** read from the
  file's own `avcC`/`av1C` boxes (plus `mp4a.40.2` when audio was kept). Without it a browser that
  cannot decode AV1 still picks the AV1 source and never tries the fallback. Background and GIF
  replacements loop silently; content gets controls and `preload="metadata"`.
- **Placeholders** in the manifest (additive, still version 3): `dominant-color` (default, confirmed),
  `lqip` (16 px WebP data URI) or `blurhash`; `--placeholder <kind|none>` on `optimize`. Refreshing
  them never re-encodes anything, and a changed source never keeps the old one. Videos use their
  poster. Snippets apply them as `style` or `data-blurhash`.
- **BlurHash** is implemented in-house (no dependency) and verified against the reference package on
  recorded vectors; see the deliberate deviation under Known issues.
- **TUI**: `/snippet @file` (works for files already optimized and hidden from the list) and `c` on
  the results screen. The clipboard uses a native tool if present, else OSC 52, and always shows the
  markup so a failed copy is never a dead end.

## M7 — what changed

- **Config loader** (`src/core/config/`): `bytecut.config.{ts,mts,js,mjs,json,toml}` in the project
  root, or `--config <path>` on every project command. No config behaves exactly like an empty one
  (tested: `{}` in JSON, TOML and JS produce the same `--dry-run --json` plan as no file). More than
  one file is an error. `.ts` is loaded by Node's own type stripping (no dependency); TOML uses the new
  `smol-toml` dependency.
- **Schema** (zod, strict): `include`, `exclude`, `outDir`, `publicPath`, `framework`, `assets`,
  `presets`, `audit.rules`, `audit.ignore`, `budgets`, `manifest.placeholder`, `concurrency`,
  `ffmpegPath`, `ffprobePath`. One error lists every problem with its path, suggests the intended key
  for a typo (including rule ids) and never prints a stack. `ssimulacra2`, `vmaf`, `raw` and
  `ssimulacra2Path` are rejected with "arrives in M9" rather than accepted and ignored.
- **Presets**: `extends` chains (any order, cycles reported), overrides for widths, formats, quality,
  effort, lossless and priority (images) and audio, maxWidth, maxFps, codecs and crf (video). A preset
  named like a built-in without `extends` changes that built-in. `target` maps to fixed numbers: AVIF
  45/60/75, WebP 65/78/88 for low/balanced/high, `lossless` forces lossless; video CRF is offset +4/0/-4.
- **Precedence** (low to high): classifier, `assets` rule (first match wins, glob against the project
  relative path; a pattern without `/` matches the name at any depth), `--preset`, a per-file choice.
  Flags beat config beat detection for `--out-dir`, `--public-path`, `--placeholder` and the ffmpeg paths.
- **`bytecut explain <file…>`**: which layer decided, the preset chain and what the config changed, the
  resolved settings and the output paths. Read-only. `--preset` shows what a flag would do; `--json`.
- **`bytecut init`**: writes `bytecut.config.json` with only values that differ from detection (`{}` if
  none), refuses if any config exists, never touches `.gitignore`, and says so if `outDir` is ignored.
- **TUI "save these choices?"**: after a run that used per-file presets or a changed output folder the
  config does not already hold, a prompt lists them (y/Enter saves, n/Esc not now); `s` on the results
  screen and `/save` ask again. JSON (or no config) is written; a TOML or TS config is never rewritten,
  the lines to add are shown instead. A declined question is not repeated for identical choices.
- **Wiring**: `audit.rules` and `budgets` now reach the audit (so `project/over-budget` fires),
  `exclude` applies to directory scans, `audit.ignore` drops findings and files from the audit,
  `framework` replaces detection, `concurrency` sets image concurrency, `ffmpegPath`/`ffprobePath`
  sit between the env var and PATH in resolution (doctor shows `config` as the source).
- **`doctor`** reports the config in use (or the problem with it, rather than refusing to diagnose),
  the framework, and whether `outDir` is matched by a `.gitignore`.
- **Guardrails**: the config file is the one write outside `outDir` (§6.2); `writeConfigFile` in
  `fs-safe.ts` accepts only the known config names in the project root, refuses symlinks and is atomic.

## M8 — what changed

- **`bytecut check`**: the audit with a verdict. Exit **0** passed, **1** a finding of severity `error`
  remains (`project/over-budget` by default, plus any rule the config promotes), **2** it could not
  run (bad flags, broken config, no git, bad ref, nothing to scan). CI can tell "fix your images" from
  "fix your pipeline". It honours the config (rules, budgets, `exclude`, `audit.ignore`) and **writes
  nothing**: no analysis cache, no manifest; the repository is byte-identical afterwards (tested).
- **`--fail-on error|warn`** (default `error`): `warn` also fails on warnings, so a zero-config CI job
  can catch stale outputs and heavy images without writing a config. This goes beyond the milestone
  text and was confirmed with you.
- **`--changed [base]`**: report only findings about files that differ from `base` (default `HEAD`,
  i.e. local changes). Changed means committed since the merge-base, staged, unstaged and untracked
  but not ignored; deletions are skipped. The audit still covers the whole project, so project-wide
  rules (total budget, duplicates, unreferenced) stay correct, and findings that name no file always
  count. A changed bytecut config file puts every file in scope. Git is read locally with argument
  arrays and never fetches; a missing ref, a non-repository and a shallow clone each say what to do.
- **`--report md|json`**: the report on stdout instead of the text report; the one-line verdict goes to
  stderr. Markdown stays under GitHub's comment limit (20 rows per rule, then a stated cutoff) and
  escapes file names and messages so a table cannot be broken; JSON has a stable shape (`version`,
  `ok`, `failOn`, `counts`, `changed`, `findings`, `failing`, `scanned`, `totals`, `unprobed`,
  `notes`). There is deliberately no `--output <file>`: §6.2 allows writes only in `outDir` and the
  config, so CI redirects stdout.
- Videos that could not be analysed because ffmpeg is missing are listed in every report instead of
  passing silently.
- Example GitHub Actions step (needs history for `--changed`):

  ```yaml
  - uses: actions/checkout@v4
    with: { fetch-depth: 0 }
  - run: npx bytecut check --changed origin/main --fail-on warn --report md > bytecut-report.md
  ```

## M9 — stage 1 of 3: the scorer (what changed)

Stages 2 (image search + `maxSize`) and 3 (video, `vmaf`, `/compare`) are not started; stage 1 was a
go/no-go gate and it passed.

- **`packages/ssimulacra2` (`bytecut-ssimulacra2`)**: a pnpm workspace package. The Rust crate
  `rust-av/ssimulacra2` 0.5.1 (**BSD-2-Clause**; notice kept in `LICENSE`/`NOTICE`) compiled to a
  62 KB `.wasm`, pinned by `rust/Cargo.lock`. The `.wasm` is **committed**, so installing, testing and
  CI never need Rust; `pnpm --filter bytecut-ssimulacra2 build:wasm` rebuilds it
  (`rustup target add wasm32-unknown-unknown`). `rayon` is off; parallelism is a pool of
  `worker_threads`, each with its own instance. The crate drags in the wasm-bindgen runtime through a
  dependency; its three imports are stubbed to throw if ever reached (none is reachable from the
  exports). Loaded lazily, only when a search runs.
- **Reference agreement**: 16 fixture pairs (two images × eight distortions: JPEG q20/50/85, WebP,
  AVIF, blur, noise, colour shift), scored by libjxl's `tools/ssimulacra2` (the Cloudinary C++
  reference, commit `ef67fde`, built from source) and by the WASM. **Largest difference 0.032** on the
  0..100 scale; typical 0.004. The test tolerance is 0.1. Golden values are in
  `test/fixtures/ssimulacra2/reference-scores.json`; the 18 PNG fixtures are committed because the
  numbers depend on their exact pixels.
- **Native scorer**: `--ssimulacra2` → `BYTECUT_SSIMULACRA2` → `ssimulacra2Path` → PATH, resolved like
  ffmpeg; WASM is the default and the fallback. An explicitly named path that is missing is reported
  and falls back to WASM, never to a different binary on PATH. Candidates are written to temp files
  inside `outDir` through `SafeFs.writeTemp` and removed. `doctor` shows which scorer will be used.
  `ssimulacra2Path` is accepted in config; `ssimulacra2`, `vmaf` and `raw` are still rejected until
  stages 2 and 3.
- **Cost** (single thread, WASM, photographic content): 512x512 in 0.4 s; 1280x720 1.3 s; 1920x1080
  1.6 s (~450 MB RSS); 2560x1440 2.6 s (~740 MB RSS). A search step on a 512 px crop is therefore
  cheap, and scoring one full-size 2560 px output is affordable.

## M9 — stage 2 of 3: image quality search (what changed)

- **Config** (image presets): `ssimulacra2: <1–100>` is the lowest acceptable score; `maxSize` caps
  one output file; `floor` is the lowest score allowed while fitting that cap. `maxSize` needs
  `ssimulacra2` and **requires `floor`** (how far quality may fall is a stated tradeoff, not a hidden
  default); `floor` must not exceed the target and means nothing without `maxSize`. `vmaf` and `raw`
  are still rejected, with the reason.
- **Plan**: an output may carry `search: { metric, target, floor?, maxBytes? }`; `quality` stays the
  preset's fixed value, used only if a search cannot run. Lossless outputs are exact and never carry one.
- **Manifest** (all optional): `search` (the parameters, plus `plannedPath` when the width was stepped
  down), `score` (measured on the full-size file) and `scorer` (`wasm`/`native`). Cache validity compares
  the search parameters, not `quality`, and ignores `scorer`.
- **Algorithm** (`src/core/quality/search.ts`), per lossy output: decode the source exactly as
  `encode` prepares it; take the 512 px tile of median detail; binary-search quality 1–100 for the
  smallest whose sample scores ≥ target (~7 crop encodes); encode full size and score it once, raising
  quality in bounded steps if the whole image disagrees with the sample. Over `maxSize`: find the
  quality where the sample scores the floor, then bisect full-size encodes for the largest that fits.
  Still over: step the width down by 10% (even widths, never below half the planned width or the next
  smaller planned width) and repeat. Alpha images are scored over white and over black, keeping the
  lower score; wide-gamut sources are compared in sRGB.
- **Never** writes an output over its cap, below its floor, larger than its source (§6.7) or upscaled.
  A constraint that cannot be met is reported as `unmet` with the sizes it did reach, nothing is
  written for it, and the run exits 1.
- **A stepped-down output is named by its real width** (`photo-418.webp`); the manifest records
  `plannedPath`, so the cache, `project/stale-output`, `project/orphaned-output` and snippets all
  treat it as the output the plan asked for (checked against a real manifest: snippet, audit and
  dry-run all agree).
- **Wiring**: `optimize` (and the TUI) create the scorer lazily, only when an output needs a search;
  `--ssimulacra2 <path>` selects a native tool; `explain` shows the search; dry-run plans show
  `ssimulacra2 >= 80, <= 150 KB` instead of a quality; results show `q67 · ssimulacra2 81.0`.
  Cancelling mid-search records `cancelled` and writes nothing.

## M9 — stage 3 of 3: video search, `vmaf`, `/compare` (what changed)

- **Config** (video presets): `ssimulacra2: <1–100>` or `vmaf: <1–100>`, one metric per preset.
  `floor` and `maxSize` stay image-only (a size cap on video is not part of M9); `vmaf` is rejected on
  image presets. `raw` is still rejected with the reason. The preset's `crf` becomes the search's
  starting point and the fallback.
- **Plan / manifest** (optional, additive): a video output may carry `search: { metric, target }`; the
  manifest records `search`, `score` and `scorer` (`wasm`, `native` or `libvmaf`) and the `crf` the
  search landed on. Cache validity compares metric and target, not `crf`.
- **Algorithm** (`src/core/quality/video-search.ts`): three clips of 2 s at 20/50/80% (a video of at
  most 6 s is scored whole). A candidate CRF is encoded per clip **in memory** (Matroska on stdout,
  decoded again through a pipe: no file is written), four evenly spaced frames per clip are scored at
  ≤512 px against the source decoded through the same fps cap and scale, and the **worst clip** is the
  CRF's score (you chose worst over mean). The CRF is found by bisection starting at the preset's CRF
  (~6 probes; AV1 10–63, H.264 10–51). A returned CRF was always measured passing.
- **Confirm**: after the real encode, the same clips are scored on the output file; a miss lowers CRF by
  2 and re-encodes, at most 3 times. A whole-video search is exact and skips this.
- **Unmet** (target unreachable at the lowest CRF, or still short after the bumps): nothing is written for
  that output, the item fails, exit 1 (you chose fail over best-effort).
- **`vmaf`**: ffmpeg `libvmaf` over the source clip and the encoded clip, at the output's resolution,
  `n_subsample=3`; the score is parsed from ffmpeg's `VMAF score:` log line. Without `libvmaf` the output
  uses the fixed CRF, a warning says so, and the manifest still records `search` (without a `score`) so
  the cache hits; once libvmaf (or a scorer) exists, that output is searched on the next run.
- **Scorer**: the same selection as images (`--ssimulacra2` → env → config → PATH, WASM fallback), the
  same lazy start. Frames are scored by the worker pool.
- **`bytecut compare <file>` and `/compare @file`** (`src/core/compare/`): `node:http` on `127.0.0.1`,
  random port, an unguessable 128-bit path token, GET/HEAD only, a Host check against DNS rebinding,
  files addressed by index into a list fixed at start (a request never names a path), only outputs the
  manifest says were written and that resolve inside `outDir`, Range support for video, a CSP that
  allows only itself, no auto-open. The page is one self-contained document: a before/after slider for
  images, synced side-by-side players for video, and the sizes, CRF/quality, metric and score.
  `Ctrl-C` stops it (SIGINT exit 0 verified); the TUI stops its servers on quit.

## Slow video scans no longer look stuck (fix after M9)

- **Report**: in a folder with only a video, `npx bytecut` sat on `Scanning 0/1 images (estimate)…`.
  Nothing was hung: the audit estimates a video with real sample encodes (3 windows x 2 codecs at the
  real preset), which took ~30 s on a fast machine for a 4K, 20 s clip and more on a laptop, and the
  progress counted whole files, so one video showed no movement. It also called a video an "image".
- **Fix**: the estimate reports each sample encode; the scanning screen now reads
  `Scanning 0/1 files (estimate)` plus `big.mp4: encoding sample 2 of 6. Large videos take a while; the
result is cached.` Checked in a real pty on a 4K clip. The estimate is cached by content hash, so the
  second scan is quick.
- **Not changed**: the estimate still costs real encodes (a confirmed decision). A faster estimate
  (downscaled samples) would trade accuracy; say if you want that.
- Tests: step reporting in the estimator, the reducer, the scanning screen, and a real-ffmpeg audit;
  the TUI video test now waits for the list row because the scanning screen names the file. The hook
  timeout is 120 s, since fixture generation in `beforeAll` could exceed 30 s under a full parallel run.

## Image output questions in the TUI (change after M9)

- **Request**: once the images are recognized, ask which formats to write, the max edge and a
  target max size, each with ready-made choices and a custom value.
- **TUI**: after the first scan that lists an image, an "Image output" panel opens: Formats
  (JPEG / WebP / AVIF, at least one), Max edge (1280 / **1920** / 2560 / 3840 / custom px) and Max size
  per file (**no cap** / 150 KB / 300 KB / 500 KB / 1 MB / custom, e.g. `250 KB`). It is pre-filled with
  what the project resolves to, shown once per session, and reopened with `i` or `/images`. Enter
  applies and rescans so the estimates follow; Esc keeps what was there.
- **Scope**: `photo`, `hero` and config presets built on them; `icon` stays lossless PNG, and a
  transparent or ambiguous source still gets PNG in place of JPEG. A cap turns on the perceptual
  search at `ssimulacra2: 80`, `floor: 65` (a preset's own target and floor are kept).
- **How**: `src/core/config/image-options.ts` turns the answers into ordinary preset definitions on
  the raw config, which the session validates and resolves exactly like a file, so review, run,
  `/save` and a later session all see the same presets. `/save` writes them to `presets.photo` /
  `presets.hero` (only the fields that change). No format changes: no new config fields.
- **Tests**: options → definitions (minimal, inherits, keeps the config's target, PNG kept, round
  trip through a written config), reducer, panel walkthrough with a fake session, and a real session
  that plans `-640.webp` / `-640.avif`, saves, and plans the same in a new session.
- **Not done**: headless flags for the same three choices (use the config); the audit still
  estimates a capped image at the preset's fixed quality.

## Video presets in the TUI, and a size cap for video (change after M9)

- **Report**: `p` on a video row cycled photo / hero / icon, and there was no way to ask for a
  target file size on video.
- **TUI**: rows know whether they are an image or a video; `p` cycles `background-video`,
  `content-video`, `gif-to-video` (plus the config's own) for video rows, and `/preset` only accepts
  names that fit what it targets, listing them in the usage line.
- **Size cap**: a video preset takes `maxSize` + `floor` with `ssimulacra2` or `vmaf`. Per output
  (AV1 and H.264 each): find the CRF that meets the target, raise it to the lowest CRF whose
  predicted size fits (sample bytes per second x duration, + audio), keep it only if it still scores
  at or above `floor`, else step the width down by 20% (not below half) and repeat. The real file is
  measured: over the cap it bumps the CRF by 2, at most 3 times, then narrows. Unmet = the item fails
  and nothing is written (exit 1).
- **Formats** (additive, no version bump): plan/manifest video `search` gains `floor`, `maxBytes` and
  `plannedPath`; a narrower file is named for its width and the manifest remembers the planned path,
  exactly as for images. The audit's video estimate is clamped to the cap.
- **Tests**: fit/step units, executor tests with a fake engine (fits by CRF, narrows, floor held,
  prediction wrong, unmet, cache hit/miss; five mutations caught), real-ffmpeg run that fits 60% of
  the uncapped size and is a cache hit the second time.
- **Not done**: a TUI key to type a size (config only, by your choice); a cap on image/vmaf mixes.

## Flat output layout (change after M9)

- Outputs are written as `<outDir>/<source's own folders>/<basename>-<width>.<ext>`: the extra
  `<basename>/` folder per image is gone, for images, videos and posters. Previously
  `img/hero/hero-640.avif`; now `img/hero-1920.jpg`. An image at the top of the static root is written
  straight into the output folder.
- Two sources that map to the same output path still abort planning with `OUTPUT_COLLISION`.
  Names stay unambiguous because the width is always in the file name (`photo-1400.jpg` versus
  `photo-as-png-400.webp`), but a folder of many images now has many files side by side.
- Outputs from earlier runs sit at the old paths and are reported as orphaned/stale; there is no
  `--prune` yet, so delete the old output folder once.
- 181 path expectations in tests were rewritten mechanically and then checked by hand; the goldens
  were regenerated and only changed in paths.

## Default format: JPEG (change after M9)

- `photo` and `hero` write **one JPEG** (mozjpeg, q80 / q85) instead of AVIF + WebP. `webp` and `avif`
  are opt-in: `presets.photo.formats: ["jpg", "webp", "avif"]` (any combination and order; the
  snippet's `<picture>` lists AVIF, then WebP, and the JPEG is the `<img>`). A JPEG-only result is a
  plain `<img>` (plus `srcset` only when a preset lists several widths).
- **JPEG cannot hold transparency or be lossless**, so the planner substitutes a lossless **PNG** for
  the `jpg` entry when the source really uses alpha (§6.9), when the preset is lossless, or when it is a
  PNG the classifier rated low confidence (§6.8). `icon` writes PNG. WebP and AVIF carry alpha
  themselves and are left alone.
- A JPEG that is not smaller than its source is still "already optimal" and not written (§6.7); real
  photos usually shrink, but an already-squeezed JPEG will not, and that is reported.
- Config: `formats` accepts `jpg`, `png`, `webp`, `avif`; `quality: { jpg: N }` is new; `target` maps
  to JPEG quality 65/80/90.
- **Consequences**: the old `image/no-modern-format` rule keeps its id but its message is now "no
  up-to-date optimized outputs"; `image/reencode-savings` still applies to WebP/AVIF sources. Existing
  AVIF/WebP outputs from earlier runs become orphans and stale entries. Video posters are still AVIF.
- Tests: the plan/audit goldens changed; suites that were about AVIF/WebP now opt in through
  `MODERN_POLICY` (and exercise that path); `test/integration/jpeg-default.test.ts` covers the default
  with real encodes, and 10 of 10 mutations of the new planner/engine/snippet logic are caught.

## Default size: longest side up to 1920 (change after M9)

- `photo` and `hero` now produce **one size per format**: the longest side is capped at 1920. A
  landscape image is 1920 wide; a portrait image is 1920 tall with the width in proportion (rounded
  down, so the height never exceeds the cap); an image within the cap keeps its size. Files are named by
  their real width (`port-960.webp`). Previously: 640/1280/1920 (photo) and 640/1280/1920/2560 (hero).
  `icon` is unchanged.
- **Config**: `widths` still works (a list of widths); the new `maxEdge` sets the longest-side cap.
  They are mutually exclusive, and each replaces the other when a preset extends one that has it.
- **Consequences**: no `srcset` set by default (snippets emit a single-candidate `<picture>`), no
  smaller variants for small screens, and `image/no-responsive-set` never fires unless a preset lists
  several widths. Output counts and committed bytes drop to a third.
- **Estimator**: trial-encodes at 640 px and extrapolates when the only planned output is wider, so an
  audit does not encode every image at 1920 (found while updating the tests: it would have).
- Tests updated for the new default (plan goldens, audit golden, optimize layout, rule-setting test) and
  a real-encode test checks landscape 1920x960, portrait 960x1920 and an in-cap portrait untouched.

## Verification (2026-10-11, Linux, Node 23.8, ffmpeg 6.1.1)

- Stage 3: `pnpm typecheck`, `pnpm lint` pass; `pnpm test` 83 files, 1080+ passed, 1 skipped (the
  native scorer comparison, gated on `BYTECUT_TEST_SSIMULACRA2`). New: CRF search with fakes (monotonic,
  non-monotonic, unreachable, clamped start), clip selection and geometry, executor paths (found, bumped,
  unmet, whole, no scorer, retry once available, vmaf, no libvmaf), cache rules, plan/manifest/config
  schemas, ffmpeg argument builders and the `VMAF score:` parser, the compare server (token, Host,
  methods, traversal, ranges, symlink and status filters, no external requests in the page), the real
  `compare` process with SIGINT, `/compare` in the TUI.
- **Real ffmpeg, built-in scorer, no native tool**: a 9 s 320x240 clip is searched (sampled), the output's
  recorded score meets the target and is not wildly above it, an independent scoring of frames the search
  did not sample agrees within the metric's spread, a higher target costs more bytes at a lower CRF, a
  second run encodes nothing and leaves the manifest byte-identical, and an unreachable target exits 1
  with no `.mp4` written. Engine primitives are checked directly (frame count and exact geometry; score
  falls as CRF rises).
- **Mutation checks**: 15 of 15 caught (pass comparison, worst-clip aggregation for search and confirm,
  unreachable detection, frame-count mismatch, confirm skipped / always run / unbounded, retry once a
  metric is available, vmaf without libvmaf, cache ignoring search in two places, Host check, token,
  unwritten outputs served). Two survived first and each got a test: confirm by the worst clip, and the
  status filter (the test's files did not exist, so the filter was never the reason).
- **`vmaf` was NOT run against a real libvmaf**: this machine's ffmpeg has no `libvmaf` filter. What is
  verified is the argument shape, the log parser (against the documented line), the engine's error when
  the filter is missing (a real ffmpeg is asked to build the graph), and the executor behaviour with a
  fake. The score semantics (pooled mean at output resolution, `n_subsample=3`, model default
  `vmaf_v0.6.1`) are unverified until someone runs it on a build with libvmaf.

## Verification (2026-10-10, Linux, Node 23.8, ffmpeg 6.1.1)

- `pnpm typecheck`: pass. `pnpm lint`: pass. `pnpm build`: pass. `pnpm test`: 924 tests in 71 files
  (~225 s here; M7 was ~145 s, the git-repository tests are slow to set up). One older test (M1
  determinism, two full AVIF encodes) timed out at 30 s once under that load and passes alone in about
  23 s, so its timeout is now 120 s. Two existing tests changed for M7 and say why: the usage-line test pinned
  the exact command list (now checks that the original commands are still present), and the real
  session test now meets the save prompt after a run that changed a preset.
- **M7 mutation checks** (each asserted as applied, 13 of 13 caught): last match wins instead of first,
  new rules appended instead of prepended, assets beating a per-file choice, `--preset` losing to
  assets, writer accepting any file name, schema not strict, `exclude` ignored, `audit.ignore` ignored,
  `init` writing defaults, the save prompt ignoring what the config holds, video target sign flipped,
  TOML/TS configs rewritten, and file names not glob-escaped. One was not caught at first (assets
  vs per-file choice); a precedence test was added and the mutation then failed as it should.
- **M9 stage 2**: 1009 tests pass, 1 skipped (the native-tool comparison, see stage 1). Real-encoder
  integration tests run `optimize -y` with the built-in scorer and **no native binary**, then measure the
  output independently: the full-size score meets the target and matches what the manifest recorded
  within 0.05; a higher target costs more bytes than a lower one; a size cap is respected and the
  floor holds; an unreachable cap exits 1 and writes nothing; a second run does no encoding and leaves
  the manifest byte-identical. Mutation-checked, 12 of 12 caught (three needed new tests first: floor
  ignored while fitting, lossless outputs marked for search, and the cache ignoring search
  parameters).
- **M9 stage 1**: 959 tests pass, 1 skipped (the comparison against a native tool, which needs
  `BYTECUT_TEST_SSIMULACRA2=<path to ssimulacra2>`; run by hand here against the built reference
  tool and passed). `pnpm typecheck`, `pnpm lint` and `pnpm build` pass.
- **M8 checks**: exit codes 0/1/2 are tested through the real CLI; `--changed` is tested in real
  temporary git repositories (untracked, modified, staged, deleted, a base branch that moved on,
  a project in a subfolder of the repository, a config change, a shallow clone, no git, a bad ref).
  Mutation-checked, 11 of 11 caught: filter ignored, project-level findings dropped, `--fail-on`
  ignored, could-not-run exiting 1, config change not widening scope, the cache being written, an
  option-looking ref accepted, untracked files ignored, diffing against the base tip instead of the
  merge-base, Markdown not escaped, and the shallow-clone hint dropped.
- **Round trip**: TUI choices (per-file presets, output folder) → written `bytecut.config.json` →
  the same executable plan with no overrides (compared without the human-readable reason), and a run
  made with the overrides is a full cache hit under the saved config.
- **Real Node type stripping** is exercised against the built bundle (`tsup` into a temp folder inside
  the repo): a `.ts` config with type annotations loads and prints no experimental warning; an
  `enum` config is reported with a readable error.
- **Generated JSX is type-checked with the real `tsc`** against `@types/react` in a sample component
  (every snippet kind, every placeholder style, an alt text needing escapes). Negative controls prove
  it can fail: `class`, lowercase `fetchpriority`/`srcset`, an HTML string `style` and `autoplay`
  are each rejected.
- **Golden snippets for five frameworks** (Next, Astro, Vite+React, Vite, static) covering a lazy
  image, an image with alt/class/sizes, a priority hero, a background video, a content video and a GIF
  replacement. Goldens are excluded from Prettier (it had rewritten the HTML ones).
- **BlurHash**: all 9 recorded vectors match the corrected reference byte for byte; the npm package's
  own output is pinned too, so the deviation cannot widen unnoticed.
- **Codec strings** read from real MP4s agree with ffprobe's profile and level, and match what is
  recorded in the manifest and emitted in the snippet.
- Mutation-checked (each mutation asserted as applied): priority ignored, source order swapped, codec
  strings dropped, URLs not encoded, values not escaped, JSX using HTML names, the BlurHash maximum
  reverted, a placeholder surviving a source change, and placeholders recomputed every run.

## Decisions

See "Decisions log" in AGENTS.md. M7 additions: Node type stripping for `.ts`; `smol-toml`; `init` and
saves write JSON and never rewrite TS/TOML; perceptual-search fields rejected until M9; fixed `target`
mapping. M6 additions: dominant colour by default; in-house BlurHash with the
absolute maximum; largest WebP as the fallback; plain `<picture>` JSX rather than `next/image`.

## Known issues

- **BlurHash deviates from `blurhash@2.0.5` on purpose.** The package takes the largest _signed_ AC
  value; the algorithm text says largest _absolute_. They differ only when the largest magnitude is
  negative, and there the package clips: about 4x the error on a dark-to-light gradient in our
  measurements (24 vs 6). On photos and noise the hashes are identical or within ~6%. We follow the
  spec; a hash made here can differ from one the npm package makes for the same pixels. Decoders are
  unaffected either way. (You chose this over byte-matching the package.)
- **`sizes` defaults to `100vw`**, which is only right for full-width images. For a card in a grid
  the browser may download a larger candidate than needed; pass `--sizes`.
- **Alt text is empty by default** (a decorative image) and a hint says so. Nothing infers a description.
- **URLs ignore framework path prefixes** (Next `basePath`/`assetPrefix`, Vite `base`): they are the
  manifest's `publicPath` plus the output path.
- **`next/image` is not used**: plain `<picture>` JSX, since the outputs are pre-generated and committed.
- **BlurHash needs a decoder on the page**; the snippet only carries `data-blurhash`. LQIP bytes can
  differ across libwebp builds, so regenerating on another platform rewrites those manifest lines.
- **Background videos use `preload="auto"`**, which fetches the whole file; a long loop may want `none`.
- **OSC 52 has no acknowledgement**: terminals and tmux configurations that ignore it fail silently
  (the markup is still shown). Windows `clip` mishandles some non-ASCII text.
- **An older bytecut cannot read a manifest written by this one** if it contains the new optional
  fields (the schema is strict); there is no published older release, so this only affects local builds.
- **Priority comes from the preset or `--priority`** per run; a persistent choice is now possible by
  assigning a preset with `priority: true` to a file. SVGs have no snippet (SVG output is still
  unimplemented and unowned).
- **`.ts` configs need a Node with type stripping** (verified on Node 23.8 only; I believe 22.18+).
  On an older 22.x the error says so and JSON/TOML still work. A `.ts` config is executed, like a
  `vite.config.ts`: it can run anything, and there is no sandbox.
- **No `defineConfig` and no published types.** Importing `bytecut` from a config would fail under
  `npx` (it is not installed in the project), so the config is a plain default-exported object and
  `import type` would have nothing to import yet. Types are a packaging decision left open.
- **`audit.ignore` only affects the audit**: `bytecut optimize` with no paths still processes those
  files; use `exclude` to keep files out of scans entirely. `exclude` does not veto a file named
  explicitly, as with `.gitignore`.
- **`check` with zero config cannot fail** unless a budget is set, because only `project/over-budget`
  defaults to `error`. Use `--fail-on warn` or promote rules in the config.
- **A path after a bare `--changed` is read as the base ref**: write paths first, or `--changed=<ref>`.
- **`--changed` still analyses the whole project.** The analysis cache is in the uncommitted `outDir`,
  so a cold CI runner pays for every file each time.
- **A project with no media passes** (`Scanned 0 images`); a wrong working directory therefore also
  passes. Only a missing asset folder is exit 2.
- **Submodules and paths outside the project folder** are not considered by `--changed`.
- **A search is slow**, because quality is found with real encodes. Measured on a 1400 px photo,
  1280 px output, target 80: WebP 3.6 s (9 encodes), AVIF 9 s (9 encodes), AVIF with a size cap 23 s
  (21 encodes). A three-width, two-format preset is therefore on the order of a minute per image the
  first time. The result is committed in the manifest and cached, so it is paid once per source; the
  audit's size estimates still use the preset's fixed quality and do not know about targets.
- **An unmet output is not recorded**, so a later run repeats its (deterministically failing) search.
- **The search assumes quality and size/score are roughly monotonic.** The full-size check and a bounded
  bump catch an optimistic sample; a very non-monotonic encoder could miss the true minimum.
- **Stepping down is by size only** (10% steps, never below half the planned width); a score target that
  cannot be reached at any quality fails rather than stepping.
- **Video search costs minutes on large sources.** On a 320x240 9 s clip a search takes ~16 s (H.264
  `slow`, 6 probes, clips run side by side); SVT-AV1 at 1080p is far heavier, since every probe encodes
  three 2 s clips at the real preset. It is paid once per source and cached by hash, but a cold CI run of
  a project with many searched videos will be slow. No time estimate is shown yet.
- **Video search quality is judged on 3 × 2 s at ≤512 px**, four frames per clip, so a scene the clips
  miss is only caught by the confirmation (which scores the same windows). A very long video with one
  hard scene elsewhere can land under target there.
- **The video fallback records `search` without `score`** so it caches; a fixed-CRF output is therefore
  indistinguishable from "searched" except by the missing score and the warning of that run.
- **Audit size estimates for video still use the fixed CRF**, as for images.
- **`vmaf` is unverified against a real libvmaf** (see verification).
- **`/compare` serves the original through the browser**: a source the browser cannot display (TIFF,
  HEIC, some GIFs) shows a broken image on the "before" side. Sizes and scores still show.
- **A native scorer can pick a different quality than WASM** once searches exist: scores differ by
  up to ~0.03, so a threshold crossing can land one step apart. Stage 2 records which scorer ran
  in the manifest and keeps it out of cache validity so runs do not ping-pong between machines.
- **The WASM binary is a build artifact in git** (62 KB). Review a rebuild by comparing the sha256
  `build-wasm.sh` prints and the pinned `Cargo.lock`; there is no reproducible-build check yet.
- **`bytecut-ssimulacra2` is not published.** It is unscoped because the `@bytecut` npm scope is taken
  by someone else (confirmed by you). Until it is published, `bytecut` resolves it through the
  workspace only, and `bytecut` itself cannot be installed from npm.
- **Config is found in the working directory only** (as detection already is); no walking upwards.
- **`concurrency` is image concurrency**; video stays at 1. `framework` replaces the detected
  framework but not React detection, which still reads `package.json`.
- **The TUI `p` key cycles image presets** (built-ins plus the config's). Video presets are chosen by
  the classifier or an `assets` rule; there is no per-file video preset key.
- **`explain` for a video needs ffprobe**, and says so when it is missing instead of guessing.
- **Saving cannot update a TS or TOML config** by design (TOML comments would be lost, TS is code):
  it prints the lines to add. A saved per-file rule is an exact path with glob characters escaped.
- **Carried over**: `--json` dry-run only; no `--prune`; no locking; `.gitignore` coverage partial;
  detection cwd-only; CI, macOS/Windows and a real SIGINT unverified.

## Next

M0–M9 are complete locally. Open items that need you, not code: a real CI run on Linux/macOS/Windows,
publishing `bytecut-ssimulacra2` then `bytecut`, a `vmaf` run on an ffmpeg with
libvmaf, and an owner for SVG output (no milestone covers it).

# PROGRESS

## Status

| Milestone                           | Status                           |
| ----------------------------------- | -------------------------------- |
| M0 Scaffold                         | Complete locally; CI not yet run |
| M1 Image engine + headless optimize | Complete locally; CI not yet run |
| M2 Plan, manifest, cache            | Complete locally; CI not yet run |
| M3 Scanner, classifier, audit       | Complete locally; CI not yet run |
| M4 TUI                              | Complete locally; CI not yet run |
| M5 – M9                             | Not started                      |

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

## Verification (2026-10-10, Linux, Node 23.8)

- `pnpm typecheck`: pass. `pnpm lint`: pass. `pnpm test`: 418/418 pass in 34 files (~100 s; M3 was ~77 s).
- **Driven under a real pseudo-terminal** (python `pty`, 30x100): scan, select, details, preset, review,
  run, cancel, command bar with `/` and `@`, `/out ..` refusal, `/help`. Each found real bugs (below).
- **Cancel verified on disk**: after Esc mid-run there were no temp files, every manifest entry matched
  its file hash, and a follow-up run wrote exactly the remaining files with no warnings.
- Component tests (ink-testing-library) cover list selection, review, run progress, cancel, command
  bar and the output-folder prompt; a real-session test cancels a live run against a temp project.

### Bugs found by the walkthrough, not by unit tests

- Preset overrides were forgotten by the rescan, so an optimized file reappeared as work to do.
- A row slightly wider than the terminal wrapped and corrupted the layout (now explicit widths).
- Pasted input arrived as one chunk and was silently ignored.
- The `@` matcher ranked `gps-map.png` above `gps.jpg` (greedy match latched onto the `g` in `img/`).
- The done screen leaked a per-output line into the totals.
- A stale status message survived closing the command bar.
- **Regression caught by the full suite**: citty runs the root command's `run` after every subcommand, so
  `optimize`, `audit` and `doctor` were each followed by a bare-`bytecut` audit (polluting `--json`,
  writing cache files, even scanning freshly written outputs as sources). The root `run` now bails out
  when a subcommand was given, with a regression test.

## Decisions

See "Decisions log" in AGENTS.md. M4 additions: one row per file; report-only section; headless
fallback prints the audit; `fix` marker on rules; overrides are session-only.

## Known issues

- **"Manual walkthrough" is not a human walkthrough.** I drove the real binary through a pty and
  read its frames, which is thorough but is not someone using a terminal emulator. You should do the
  final pass in a real terminal (resize, colours, a very narrow window, a slow disk).
- **Preset overrides last for the session only.** The audit after quitting will classify the file
  again and call it un-optimized. Persisting choices is the M7 "save these choices?" prompt.
- **Cancel waits for the in-flight encode** (sharp cannot be interrupted): up to a few seconds for a
  large AVIF. The UI says so while it waits.
- **No terminal-resize handling beyond Ink's re-render**; very narrow terminals (<60 cols) will truncate
  paths heavily and were not tested.
- **The TUI scan is the audit**: cold scans of big projects show a counter, not per-file names, and
  cost the same as `bytecut audit` (~10 s per 200 small images).
- **`/doctor` reads once per open** and is not refreshed; `/quit` and `q` while a run is queued are not
  distinguished from cancel.
- **Carried over**: SVG output is still unimplemented and unowned by a milestone; animated GIFs are
  report-only until M5; `--json` is dry-run only; no `--prune`; no locking; `.gitignore` coverage is
  partial; detection is cwd-only; CI, macOS/Windows and a real SIGINT are unverified.

## Next

M5 — video (ffprobe, AV1 + H.264, posters, degradation paths). New runtime binary dependencies are
the user's own ffmpeg, so expect questions about fixtures and CI, not packages.

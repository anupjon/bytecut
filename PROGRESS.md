# PROGRESS

## Status

| Milestone                           | Status                           |
| ----------------------------------- | -------------------------------- |
| M0 Scaffold                         | Complete locally; CI not yet run |
| M1 Image engine + headless optimize | Complete locally; CI not yet run |
| M2 Plan, manifest, cache            | Complete locally; CI not yet run |
| M3 Scanner, classifier, audit       | Complete locally; CI not yet run |
| M4 – M9                             | Not started                      |

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

## Verification (2026-10-10, Linux, Node 23.8)

- `pnpm typecheck`: pass. `pnpm lint`: pass. `pnpm test`: 316/316 pass (~77 s; M2 was ~22 s).
- **Golden**: audit hits on the fixture project (29 hits across 13 rules) and the dry-run plan.
- **Estimator accuracy**: worst error 16.9% over 12 extrapolated outputs (28 outputs total), against
  the ±25% target. Three of those images were not used to choose the exponent.
- **Performance** (200 tiny files): warm audit 46 ms vs the 10 s target; cold 10.7 s.
- Mutation-checked: disabling the covered-image check, gitignore negation, the size exponent, or GPS
  detection each fails the intended tests.
- Manual runs of the built CLI: cold/warm audit, `--no-cache`, `--json`, optimize then audit.

## Decisions

See "Decisions log" in AGENTS.md. M3 additions: layout relative to the static root + manifest v2; `ignore`
dependency; cache inside outDir; estimator exponent 1.6; source-level rules skip covered images.

## Known issues

- **The estimator's exponent is a prior, not a law.** It was chosen on three synthetic images; implied
  exponents ranged 1.46–1.82 and a per-image fit was _worse_. The ±25% result holds on my fixtures; real
  photographs are unverified. Estimates are labelled `~` in the report.
- **All classifier thresholds are first guesses** (64 colours, 1024px icon cap, 1920px + 1.6 aspect for
  hero, name tokens) validated only on synthetic fixtures. Wrong verdicts degrade gracefully (the
  fallback is `photo`) but are possible. `hero`/`icon` quality and widths are likewise unmeasured.
- **SVG output is not implemented, and no milestone covers it.** `optimize` skips SVGs with a note;
  `svg/*` rules only report an svgo estimate. Needs a decision on where it belongs.
- **Animated GIFs are only reported** (needs ffmpeg, M5). No savings number is given, deliberately.
- **`project/unreferenced` is name-based** and blind to dynamic references; it is `info` for that reason.
  The scan reads text files ≤1 MiB, 64 MiB total, and says so if truncated.
- **`audit` writes to outDir** (the cache) unless `--no-cache`: on a never-optimized project this creates
  `<outDir>/.bytecut-cache/` — the option you chose; flagging it because it is a visible side effect.
- **Cold audit is slow-ish**: 10.7 s for 200 tiny files (2 trial encodes each); no progress output yet.
  Large images will cost more per file.
- **Rule overlap**: an unoptimized large JPEG can legitimately hit no-modern-format, oversized,
  no-responsive-set, heavy and unreferenced. The summary de-duplicates savings; the per-rule sections
  do not.
- **Settings and budgets have no CLI/config surface** until M7; `project/over-budget` is inert from the CLI.
- **`.gitignore` coverage is partial**: `.git/info/exclude`, the global gitignore and `.gitignore` files
  in directories above the cwd are not read.
- **Detection is cwd-only**: no monorepo/workspace handling; Nuxt, SvelteKit, Remix etc. fall back to
  `static` (which still works when a `public/` folder exists).
- **Test suite time** tripled (~77 s) from real-encode integration tests; fine locally, worth watching in CI.
- **Carried over from M2**:
  - `--json` works only with `--dry-run`; a JSON result for real runs isn't designed.
  - Encoder drift is reported, not acted on: `--force` is the only way to regenerate, and it re-encodes
    everything rather than just the drifted outputs.
  - No `--prune`: orphans are reported and stay listed in the manifest (so they remain deletable under
    §6.3), but nothing deletes them.
  - No locking: two concurrent runs on one outDir could overwrite each other's manifest update.
  - Every run hashes every source and written output to decide the cache.
  - Golden snapshots use a fake engine and hand-written bytes on purpose: real sharp bytes differ across
    libjpeg/libvips builds and would break the OS matrix.
- Still unverified: CI, macOS/Windows, a real SIGINT through the CLI. Still no git repo.

## Next

M4 — TUI (Ink). It needs a confirmed plan first (§10). It is the first milestone with a new runtime
dependency set (`ink`, `react`) and a manual-walkthrough acceptance criterion, so expect questions about
scope and testing approach.

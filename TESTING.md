# Testing 🧪

PicToWebP ships **three independent implementations** , a Python CLI, a Rust
CLI, and one web UI with two backends (in-browser workers + local FastAPI).
They share a single behavioural contract, so the testing strategy is built
around one idea: **every artifact is exercised live, end to end, against the
same test data**.

## Quick start

```bash
# Python (CLI + FastAPI) , unit, integration and live subprocess e2e
uv sync
uv run ruff check src_py tests
uv run ruff format --check src_py tests
uv run pyright
uv run pytest

# Rust CLI , unit tests + live compiled-binary e2e
cd src_rust
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test

# Web UI , unit, then both Playwright suites (each builds its own profile)
cd web-ts
npm test
npm run test:e2e            # static / browser-backend build
npm run test:e2e:python     # python-backend build served by FastAPI
```

All suites are expected green before committing , currently **97 pytest,
44 cargo, 23 vitest, 10 Playwright e2e**.

## The shared fixture corpus 🗂️

Every live e2e suite converts a copy of the **same corpus**
(`tests/e2e/fixtures/`), so the Python CLI, the Rust CLI and both web editions
are verified against identical data:

```
a.png  b.jpg  c.webp  d.bmp  e.tiff  f.gif     # every supported format
nested/deep/leaf.png                           # nested directories
dup.png  dup.jpg                               # same-stem collision (both skipped)
.hidden/skip.png                               # dot-directory (skipped)
broken.png                                     # corrupt file (sad path)
```

Regenerate or modify it with:

```bash
uv run python tests/e2e/gen_fixtures.py
```

Each suite **copies the corpus into a fresh temp folder per run and cleans up
afterwards** , the repo is never polluted, and a broken test cannot leave
output behind.

## Realistic dataset + performance 🏎️

The tiny corpus proves correctness; a **500-photo set of real photographs**
(`tests/e2e/real_images/`, gitignored) proves it at scale and doubles as a
performance benchmark.

```bash
uv run python tests/e2e/download_real_dataset.py   # 500 photos (~60-150 MB)
```

- Fetched from Lorem Picsum (real Unsplash-sourced photos), with a fraction
  re-encoded to PNG/WebP so every codec is exercised.
- **Idempotent** , already-complete sets are reused as-is, nothing is
  re-downloaded and the source data is **never deleted**.
- **Rate-limited** , requests are throttled to `--rate` req/s across
  `--threads` workers, and HTTP 429 responses honour `Retry-After`.
- **Automatic** , the gated realistic tests download it on demand if missing
  and skip if the download fails (`PICTOWEBP_SKIP_REAL_DOWNLOAD=1` force-skips
  Python).
- **Clean by default** , the CLIs always run with `--no-log` from disposable
  temp dirs, so a green run leaves no `pictowebp.log`, temp corpora or output
  folders behind (see the golden rules below). See
  [BENCHMARK.md](BENCHMARK.md) for the readable version of the numbers.

The realistic tests (present in **all four** suites) run a full set through
each CLI and a 40-photo subset through both web editions, asserting every
photo converts with no failures , and while doing so they capture
**performance metrics** relevant to a bulk image→WebP converter:

| Metric | Meaning |
| --- | --- |
| `images`, `source_mib`, `output_mib` | volume being converted |
| `reduction_pct` | how much smaller the WebP output is |
| `wall_seconds` | harness-measured wall-clock time |
| `images_per_second`, `mib_per_second` | throughput |
| `tool_seconds` etc. | the CLI's own reported stats (cross-check) |

E2E runs append to `tests/e2e/perf-results.json` (gitignored), and the web
editions log their UI-reported elapsed time (`[perf] ...`). For a dedicated,
multi-run Python-vs-Rust comparison:

```bash
uv run python tests/e2e/run_realistic_bench.py --runs 3
```

This builds the Rust CLI in release mode if needed, runs each CLI `--runs`
times on temp copies (cleaned up), prints a summary table and writes the
`bench` section of `perf-results.json`. Example output:

```
  python-cli  500 img | 28.37s | 17.63 img/s | 2.29 MiB/s | 60.8% smaller
  rust-cli    500 img | 14.44s | 34.62 img/s | 4.49 MiB/s | 60.7% smaller
```

## Suite deep-dives

### Python , `pytest` (94 = 93 passed, 1 gated skip)

| File | Kind | What it covers |
| --- | --- | --- |
| `tests/test_cli.py` | integration | argparse validation, interactive prompts, `main()` exit codes (0/2/3/130), lossless/keep-metadata/report/no-log flags, non-TTY progress suppression, `--version`, `~` expansion |
| `tests/test_converter.py` | unit | the conversion engine: collisions, EXIF embedding, atomic writes, cancellation, error report |
| `tests/test_discovery.py` `test_paths.py` `test_progress.py` `test_style.py` `test_utils.py` | unit | image discovery, output-folder allocation, thread-safe progress, ANSI styling, disk/format helpers |
| `tests/test_web.py` | integration | FastAPI endpoints (convert/cancel/progress-SSE/validate/browse/single-upload/zip), SPA serving. One test is gated on `web-ts/dist-python` being built |
| `tests/e2e/test_cli_e2e.py` | **live subprocess e2e** | spawns the real `python -m pictowebp`: exit codes, `<source>_webp_<timestamp>` contract, collision/hidden/corrupt handling, crash-safe output, EXIF keep/strip, lossless, interactive prompts via stdin, empty/no-op folders, and the gated **realistic-dataset** run with perf capture |

### Rust , `cargo test` (42 = 32 unit + 10 live-binary)

- **Unit** (inline `#[cfg(test)]` in `convert.rs`, `discovery.rs`, `paths.rs`,
  `settings.rs`, `style.rs`, `ui.rs`, `main.rs`): mirrors the Python unit
  coverage , conversion engine, collisions, EXIF embedding, atomic
  writes, error report, argument validation.
- **`tests/cli_e2e.rs`** (**live e2e**): spawns the **compiled binary** via
  `CARGO_BIN_EXE_pictowebp` against the shared corpus and asserts the same
  behaviours as the Python subprocess suite , interactive prompt flow via
  piped stdin, and the gated **realistic-dataset** run reporting elapsed
  time and throughput.

### Web UI , vitest (18)

`web-ts/src/core.test.ts` covers the pure logic shared by both backends:
collision detection, canvas-limit clamping, output-name handling, and
formatting helpers.

### Web UI , Playwright (10)

Both suites run the **production build** in real Chromium.

| Spec | Backend | Coverage |
| --- | --- | --- |
| `e2e/smoke.spec.ts` (3) | browser | page load + privacy messaging + quality slider, single-image conversion → WebP download, **runtime proof of zero external network requests** |
| `e2e/batch.spec.ts` (3) | browser | multi-file drag-drop → batch conversion → ZIP download (contents inspected), corrupt-input failure surfaced in the UI and excluded from the ZIP, and a gated **realistic 40-photo** batch logging UI-reported throughput |
| `e2e-python/smoke.spec.ts` (2) | python | server-edition options (lossless/metadata controls), single-image upload through the API, CSP `connect-src 'self'` |
| `e2e-python/batch.spec.ts` (2) | python | full folder conversion: browse modal → navigate → convert via SSE → ZIP download inspected, sad paths reported in the results UI, and a gated **realistic 40-photo** server batch |

The python suite boots the real `uv run uvicorn pictowebp.web.app:app`; the
browser suite serves the static build via `vite preview`. Both reuse a running
server on repeat runs and clean up their temp corpora in `finally` blocks.

## Behaviour coverage matrix ✅

| Scenario | Py CLI | Rust CLI | Web static | Web python |
| --- | --- | --- | --- | --- |
| Happy path, every format | ✓ | ✓ (supported) | ✓ | ✓ |
| Same-stem collision skip + report | ✓ | ✓ | ✓ | ✓ |
| Hidden directory skipped | ✓ | ✓ | , | ✓ |
| Corrupt input → no partial output | ✓ | ✓ | ✓ | ✓ |
| Error report file | ✓ | ✓ | n/a | ✓ |
| Exit 0 partial / 2 bad path / 3 all-broken | ✓ | ✓ | n/a | n/a |
| Resize, never upscales | ✓ | ✓ | unit | unit |
| Lossless | ✓ | ✓ | n/a | , |
| EXIF keep vs strip | ✓ | unit | n/a | , |
| Interactive prompts (stdin) | ✓ | ✓ | n/a | n/a |
| Empty / no-op folder | ✓ | ✓ | n/a | n/a |
| Output-folder `<src>_webp_<ts>` contract | ✓ | ✓ | n/a | n/a |
| Single-image → download | , | , | ✓ | ✓ |
| Batch → ZIP download | , | , | ✓ | ✓ |
| Zero external network | , | , | ✓ | , |
| Server browse-modal navigation | , | , | , | ✓ |

`,` means the scenario does not apply to that artifact; `unit` means it is
covered at unit level rather than live.

## Intentional gaps 🚧

Some behaviours are deliberately *not* live-tested because they are flaky or
not automatable, and are instead covered by unit/in-process tests:

- **Cancellation** (SIGINT / Ctrl+C): timing-sensitive; covered by in-process
  tests on both CLIs.
- **File System Access picker** (folder picker and "Save to folder" in the
  browser edition): cannot be driven by Playwright.
- **UI lossless / metadata toggles**: unit-level; the python backend's
  behaviour is identical to the CLI's (which IS live-tested).

## What the e2e suite has caught 🐛

Live testing against real artifacts found bugs that unit tests could not:

1. **Browse modal crash** , the server browse modal crashed on every non-drive
   directory listing (`browseTo` iterated a `drives` key that ordinary listings
   omit). Fixed with a `drives ?? []` guard.
2. **Browser ZIP misnaming** , batch ZIPs and "save to folder" wrote WebP bytes
   under the original filenames (`a.png`). Fixed to use the converted
   `<stem>.webp` path.

The message: if a behaviour can be exercised live, it should be.

## Golden rules for contributors ✍️

- **One corpus, reused everywhere** , add new fixture cases to
  `tests/e2e/gen_fixtures.py`, not to individual suites.
- **Realistic runs are optional, automatic and non-destructive** , the
  500-photo set downloads on demand, is never deleted, and only works on temp
  copies; perf results live in gitignored `perf-results.json`.
- **Every suite cleans up after itself** , temp corpora and output folders are
  removed in `finally` / `tmp_path` / `remove_dir_all`, never left behind.
- **Keep the two CLIs mirroring each other** , a new CLI behaviour deserves a
  subprocess test in both `tests/e2e/test_cli_e2e.py` and
  `src_rust/tests/cli_e2e.rs`.
- **One web UI, both backends** , a new UI flow deserves a Playwright test in
  both `web-ts/e2e/` and `web-ts/e2e-python/`.
- **Never weaken the CSP** , the static build's `connect-src 'none'` is what
  makes the zero-network test meaningful.
- Keep the suite counts in `AGENTS.md` / `CONTRIBUTING.md` in sync when you add
  or remove tests.
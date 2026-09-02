# Contributing to PicToWebP 🛠️

Thanks for wanting to make images smaller! This guide covers the project
layout, how to run each implementation locally, how to test, and what we expect
from a pull request.

## Project Layout

```
├── src/pictowebp/            # Python package (CLI + FastAPI web UI)
│   ├── __main__.py           # `python -m pictowebp` entry point
│   ├── cli.py                # argparse CLI: argument parsing, prompts, `main()`
│   ├── ui.py                 # terminal output: banners, settings, summary (↔ Rust ui.rs)
│   ├── converter.py          # conversion engine: batch pool + per-file encoding (↔ Rust convert.rs)
│   ├── discovery.py          # recursive image discovery (↔ Rust discovery.rs)
│   ├── enums.py              # input/output image format definitions
│   ├── paths.py              # unique output-folder allocation (↔ Rust paths.rs)
│   ├── progress.py           # thread-safe progress tracker
│   ├── utils.py              # error categorization, disk probes, formatting
│   ├── style.py              # ANSI styling primitives (shared)
│   ├── constants.py          # tunable constants
│   ├── web/                  # FastAPI API server (the SPA itself lives in web-ts/)
│   │   ├── app.py            # converts via the same engine as the CLI
│   │   └── schemas.py        # Pydantic request models
│   ├── console.py            # UTF-8 stdio helpers
│   └── logging_setup.py      # logging configuration
├── src_rust/                 # Rust crate (CLI)
│   └── src/
│       ├── main.rs           # entry point, Ctrl+C handling, exit codes
│       ├── settings.rs       # clap argument definitions and prompt fallbacks
│       ├── ui.rs             # banner, progress bar, summary
│       ├── style.rs          # ANSI styling + disk-space helpers
│       ├── convert.rs        # rayon-based conversion engine
│       ├── discovery.rs      # recursive file walker
│       └── paths.rs          # unique output-folder allocation
└── web-ts/                   # The single web UI (Vite + TypeScript, two backends)
    ├── index.html            # one merged markup for both editions
    ├── src/
    │   ├── main.ts           # UI state machine + interactions (backend-agnostic)
    │   ├── ui/               # DOM helpers (dom.ts)
    │   ├── backend/          # ConversionBackend contract
    │   │   ├── types.ts      #   interface + capabilities + shared types
    │   │   ├── browser.ts    #   in-browser engine (workers + FS access + JSZip)
    │   │   ├── python.ts     #   thin client over the FastAPI API
    │   │   └── index.ts      #   backend chosen at build time (VITE_BACKEND)
    │   ├── ui.css            # shared design system (both editions bundle it)
    │   ├── converter.ts      # worker pool, Canvas→WebP fallback, folder enumeration
    │   ├── worker.ts         # OffscreenCanvas conversion worker
    │   └── core.ts           # pure logic: collisions, canvas-limit clamping, formatting
    ├── e2e/                  # Playwright tests (static/browser backend;
                          #   batch.spec.ts = multi-file drop → batch → ZIP)
    └── e2e-python/           # Playwright tests (python backend via FastAPI;
                              #   batch.spec.ts = live folder conversion → ZIP)
```

## Development Setup

### Python

```bash
uv sync                                   # or: pip install .[web] (adds the FastAPI server)
uv run pictowebp path/to/images           # run the CLI
uv run pictowebp-web                      # run the web UI
```

### Rust

```bash
cd src_rust
cargo run --release
```

### Web UI (one SPA, two backends)

```bash
cd web-ts
npm install
npm run dev              # dev server (browser backend)
npm run build            # static build → dist/  (browser backend, GitHub Pages)
npm run build:python     # server build → dist-python/  (python backend, FastAPI)
npm test                 # unit tests for the conversion logic
```

## Running Tests & Linters

> For the full picture — what every suite covers, the shared fixture corpus,
> and the live e2e guarantees — see [TESTING.md](TESTING.md).

```bash
# Python: format, lint, test
uv run ruff check src tests
uv run ruff format --check src tests
uv run pytest

# Rust: format, lint, test
cd src_rust
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test

# Web UI: typecheck + build + unit tests
cd web-ts
npm run build
npm run build:python
npm test

# Web UI E2E (builds must exist; chromium via `npx playwright install chromium`)
cd web-ts
npm run test:e2e           # static build (browser backend)
npm run test:e2e:python    # python build served by FastAPI
```

All test suites are expected to be green before submitting changes:

- `python -m pytest` — **94 tests** (93 passed, 1 gated skip on the built SPA) covering the CLI, conversion engine, progress tracker, image utilities, ANSI styling, FastAPI endpoints, SPA serving, and end-to-end flows — **including 12 live subprocess tests** that run the real `python -m pictowebp` against the shared fixture corpus (exit codes, output-folder contract, collision/hidden/corrupt handling, EXIF keep/strip, lossless, interactive prompts, empty/no-op folders) plus a gated realistic-dataset run with performance capture.
- `uv run pyright` — **0 errors, 0 warnings** under `[tool.pyright]` config (standard mode, Python 3.10).
- `cargo test` — **42 tests** covering the conversion engine end-to-end (successes, failures, collisions, cancellation), EXIF embedding, atomic file writes, error report persistence, CLI argument validation — **including 10 live-binary tests** that spawn the compiled executable against the same shared fixture corpus (mirroring the Python subprocess suite and a gated realistic-dataset run).
- `npm test` (in `web-ts/`) — **18 tests** covering collision detection, canvas-limit clamping, output-name handling, and formatting helpers.
- `npm run test:e2e` (in `web-ts/`) — **6 Playwright tests** driving the static build in real Chromium (UI load, single-image conversion, a runtime proof that the conversion makes zero external network requests, a multi-file drop → batch conversion → ZIP download flow, its corrupt-input failure path, and a gated realistic 40-photo batch logging UI-reported throughput).
- `npm run test:e2e:python` (in `web-ts/`) — **4 Playwright tests** driving the python build served by FastAPI (server edition, single-image upload, a full batch conversion: browse modal → folder convert via SSE → ZIP download inspected in the browser with sad-path results surfaced in the UI, and a gated realistic 40-photo server batch).

Dependencies are declared in `pyproject.toml` (locked via `uv.lock`), `src_rust/Cargo.toml` (locked via `Cargo.lock`), and `web-ts/package.json` (locked via `package-lock.json`).

## Deploying the Browser Edition

Deployment to GitHub Pages is automatic: `.github/workflows/deploy-web-ts.yml`
builds and tests `web-ts/` on every push to `main` that touches `web-ts/**` (or
the workflow itself), verifies the Content-Security-Policy is present in the
build output, and publishes via `actions/deploy-pages`.

Two things the workflow needs from repository settings:

- **Actions permissions** must be *Allow all actions and reusable workflows*
  (with `local_only`, every run fails at startup because the official
  `actions/*` can't be used).
- **Pages** must have *Build and deployment → Source: GitHub Actions*.

The production build injects a strict CSP and sets the base path for Pages —
both configured in `web-ts/vite.config.ts`. Don't weaken the CSP; it is part of
the privacy guarantee.

### Shared UI design system

There is one web UI and one stylesheet: `web-ts/src/ui.css` — the "Obsidian
Glass" design system (tokens, glassmorphism, components, responsive
breakpoints). Both build profiles bundle it via an import in
`web-ts/src/main.ts`. Change the design in `ui.css` only. The UI loads no
external assets (no Tailwind CDN, no web fonts), so the whole product stays
fully offline. The single UI is driven by the `ConversionBackend` interface in
`web-ts/src/backend/`; the python profile and the static profile are the same
codebase with a different backend chosen at build time.

## Pull Requests

- One logical change per PR; keep the fun tone in user-facing copy.
- New features on one implementation should be mirrored on the others where it
  makes sense (the CLIs intentionally share a surface; see the flags tables
  below).
- Run the relevant test suite(s) and linters before pushing.
- Never add network calls, telemetry, or external assets to any edition — see
  the privacy guarantees in the README.

## Reference: CLI & API Details

### Python CLI flags

| Flag | Description | Default |
| --------------- | --------------------------------------- | ---------------- |
| `path` | Source folder | interactive prompt |
| `-q, --quality` | WebP quality, 1–100 | `80` |
| `-t, --threads` | Number of workers converting in parallel | all CPU cores |
| `--lossless` | Use lossless WebP encoding (overrides `--quality`) | off |
| `--keep-metadata` | Keep EXIF/metadata (default: strip) | off |
| `--no-progress` | Disable the progress bar | off |
| `--no-log` | Do not write to `pictowebp.log` | off |
| `--report PATH` | Custom path for the conversion-errors report | `<output>/conversion-errors.txt` |
| `--version` | Print the version and exit | |
| `-h, --help` | Print help and exit | |

### Python exit codes

| Code | Meaning |
| ---- | ------------------------------------------------------------------------ |
| `0`  | At least one file was converted successfully (skipped files are reported as warnings, not errors). |
| `2`  | The source folder does not exist or is not a directory. |
| `3`  | Every file failed to convert — a hard failure, no output produced. |

Pressing `Ctrl+C` stops the run gracefully: everything already converted is
kept, the summary is printed, and the exit code is `0` (or `3` if nothing
converted). Pressing `Ctrl+C` a second time exits immediately with code `130`.

### Web UI JSON API

The FastAPI server (bound to `127.0.0.1` by default) also exposes a small JSON
API. Only one conversion runs at a time; concurrent requests get `429 Too Many Requests`.

| Endpoint | Method | Description |
| ------------------ | ------ | ---------------------------------------------------------------------- |
| `/` | GET | The unified SPA (served from `web-ts/dist-python`) |
| `/convert` | POST | Start a conversion job (`202 Accepted`) |
| `/convert/cancel` | POST | Request cancellation of the current job |
| `/progress` | GET | Server-sent events with live progress snapshots |
| `/api/status` | GET | One-shot JSON snapshot of the current progress |
| `/api/validate` | POST | Validate a source folder |
| `/api/browse` | POST | List subdirectories at a path |
| `/api/history` | GET | Conversion history (newest first) |
| `/api/history` | DELETE | Clear conversion history |
| `/api/open-folder` | POST | Open a folder in the OS file explorer |
| `/api/convert-single` | POST | Convert one uploaded image and stream the result back |
| `/api/download-zip` | GET | Stream the last conversion's output folder as a ZIP |
| `/assets/*` | GET | Bundled SPA assets (from `web-ts/dist-python`) |

Example:

```bash
curl -X POST http://127.0.0.1:8000/convert \
  -H "Content-Type: application/json" \
  -d '{"source_folder": "C:/path/to/images", "quality": 85, "threads": 8, "lossless": false, "strip_metadata": true}'
```

### Rust CLI

Requires Rust 1.85+ (edition 2024). The Rust CLI exposes the same surface as
the Python one (minus `--no-log`, which has no analogue):

| Flag | Description |
| --------------- | --------------------------------------- |
| `[PATH]` | Source folder |
| `-q, --quality` | WebP quality, 1–100 |
| `-t, --threads` | Number of conversion workers |
| `--lossless` | Lossless WebP encoding (overrides `--quality`) |
| `--keep-metadata` | Keep EXIF/metadata (default: strip) |
| `--no-progress` | Do not render the progress bar |
| `--report` | Custom path for the conversion-errors report |
| `-V, --version` | Print version and exit |
| `-h, --help` | Print help and exit |

#### Exit codes (Rust)

`0` (success) · `1` (unexpected error) · `2` (invalid arguments or bad source folder) · `3` (every file failed) · `130` (cancelled by `Ctrl+C`).

The Rust version walks the source tree, encodes every image to WebP on a rayon
thread pool, mirrors the directory structure, and prints a savings report.

### Failure report format

```
PicToWebP conversion errors

[Corrupt or mislabeled image] Invalid PNG signature.
C:\photos\Screenshot_2017-08-24-18-45-49.png

[Corrupt or mislabeled image] unexpected end of file
C:\photos\Screenshot_2018-08-08-19-27-32.png
```

Every entry is two lines: a `[Category]` line with the error reason, then the
full path. Paths are stripped of the Windows verbatim `\\?\` prefix for
readability.

---

Happy hacking! 🎉

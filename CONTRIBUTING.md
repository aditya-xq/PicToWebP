# Contributing to PicToWebP 🛠️

Thanks for wanting to make images smaller! This guide covers the project
layout, how to run each implementation locally, how to test, and what we expect
from a pull request.

## Project Layout

```
├── src/pictowebp/            # Python package (CLI + FastAPI web UI)
│   ├── __main__.py           # `python -m pictowebp` entry point
│   ├── cli.py                # argparse-based CLI
│   ├── converter.py          # ProcessPool-based conversion engine
│   ├── progress.py           # thread-safe progress tracker
│   ├── utils.py              # image discovery, output-folder resolution, per-file conversion
│   ├── style.py              # ANSI styling helpers (shared)
│   ├── constants.py          # tunable constants
│   ├── web/                  # FastAPI app + single-page web UI
│   │   ├── app.py
│   │   └── schemas.py
│   └── templates/
│       ├── index.html
│       └── ui.css            # shared design system (used by web-ts too)
├── src_rust/                 # Rust crate (CLI)
│   └── src/
│       ├── main.rs           # entry point, Ctrl+C handling, exit codes
│       ├── settings.rs       # clap argument definitions and prompt fallbacks
│       ├── ui.rs             # banner, progress bar, summary
│       ├── style.rs          # ANSI styling + disk-space helpers
│       ├── convert.rs        # rayon-based conversion engine
│       ├── discovery.rs      # recursive file walker
│       └── paths.rs          # unique output-folder allocation
└── web-ts/                   # Browser-only edition (Vite + TypeScript)
    └── src/
        ├── main.ts           # UI state, interactions, history, share-stats
        ├── converter.ts      # worker pool, Canvas→WebP fallback, folder enumeration
        ├── worker.ts         # OffscreenCanvas conversion worker
        └── core.ts           # pure logic: collisions, resize math, formatting
    └── e2e/                  # Playwright smoke tests (chromium)
```

## Development Setup

### Python

```bash
uv sync                                   # or: pip install .
uv run pictowebp path/to/images           # run the CLI
uv run pictowebp-web                      # run the web UI
```

### Rust

```bash
cd src_rust
cargo run --release
```

### Browser edition

```bash
cd web-ts
npm install
npm run dev            # dev server
npm run build          # production build into dist/
npm test               # unit tests for the conversion logic
```

## Running Tests & Linters

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

# Browser edition: typecheck + build + test
cd web-ts
npm run build
npm test

# Browser edition E2E (builds must exist; chromium via `npx playwright install chromium`)
cd web-ts
npm run test:e2e
```

All test suites are expected to be green before submitting changes:

- `python -m pytest` — **84 tests** covering the CLI, conversion engine, progress tracker, image utilities, ANSI styling, FastAPI endpoints, static UI assets, and end-to-end flows.
- `cargo test` — **33 tests** covering the conversion engine end-to-end (successes, failures, collisions, cancellation), resize behavior, EXIF embedding, atomic file writes, error report persistence, and CLI argument validation.
- `npm test` (in `web-ts/`) — **20 tests** covering collision detection, canvas-limit clamping, resize math (never upscales), output-name handling, and formatting helpers.
- `npm run test:e2e` (in `web-ts/`) — **2 Playwright smoke tests** driving the built site in real Chromium (UI load + single-image conversion with download).

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

Both web UIs (Python template and browser edition) use one stylesheet:
`src/pictowebp/templates/ui.css` — the "Obsidian Glass" design system (tokens,
glassmorphism, components, responsive breakpoints). The Python app serves it at
`/static/ui.css`; the browser edition bundles it via an import in
`web-ts/src/main.ts`. Change the design in `ui.css` only — never restyle one UI
independently. The Python UI loads no external assets (no Tailwind CDN, no web
fonts), so the whole product stays fully offline.

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
| `--resize-width` | Maximum width in pixels, 16–16384 | original |
| `--resize-height` | Maximum height in pixels, 16–16384 | original |
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
| `/` | GET | The web UI |
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
| `/static/ui.css` | GET | Shared design system (bundled by the browser edition too) |
| `/static/app.js` | GET | Web UI application logic |
| `/static/ui-core.js` | GET | Shared UI helpers (formatting, toasts) |

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
| `--resize-width` | Maximum width in pixels, 16–16384 |
| `--resize-height` | Maximum height in pixels, 16–16384 |
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

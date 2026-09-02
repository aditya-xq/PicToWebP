# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

PicToWebP converts images (JPG/PNG/WebP, plus BMP/TIFF/GIF in Python) to WebP,
bulk or single, in three independent implementations:

- `src_py/pictowebp/` — Python CLI + FastAPI server (uvicorn, binds `127.0.0.1`)
- `src_rust/` — Rust CLI (rayon, edition 2024)
- `web-ts/` — the single web UI (Vite + TypeScript) with **two backends**
  behind one `ConversionBackend` adapter interface:
  - *browser* backend (OffscreenCanvas workers, File System Access, JSZip) —
    shipped to GitHub Pages via the static build;
  - *python* backend (thin HTTP client over the FastAPI API + SSE) — shipped
    by the `build:python` profile and served by `pictowebp-web`.

The two CLIs intentionally share the same flags and behavior. The web UI is
one codebase; the backend is chosen at build time (`VITE_BACKEND`).

## Commands

```bash
# Python (use uv; venv lives in .venv)
uv sync
uv run ruff check src_py tests
uv run ruff format --check src_py tests
uv run pyright
uv run pytest

# Rust
cd src_rust && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test

# Web UI — one SPA, two build profiles
cd web-ts && npm test && npm run build          # static (browser backend) → dist/
cd web-ts && npm run build:python               # server profile → dist-python/
cd web-ts && npm run test:e2e                   # static Playwright smoke (chromium)
cd web-ts && npm run test:e2e:python            # python-backend Playwright smoke
```

All suites are expected green before committing (currently 94 pytest, 42 cargo
test, 18 vitest, 10 Playwright e2e).

Every tool is covered by a **live e2e regression suite** that runs the real
artifact against a copy of the shared fixture corpus (`tests/e2e/fixtures`,
regenerated via `uv run python tests/e2e/gen_fixtures.py`):
- `tests/e2e/test_cli_e2e.py` spawns `python -m pictowebp` as a subprocess
  (exit codes, output-folder contract, collision/hidden/corrupt handling,
  EXIF keep/strip, lossless, interactive prompts, empty/no-op folders);
- `src_rust/tests/cli_e2e.rs` spawns the compiled binary via
  `CARGO_BIN_EXE_pictowebp` and mirrors the same behaviors; both clean up
  their temp folders afterwards;
- `web-ts/e2e/batch.spec.ts` drives the browser edition in Chromium (multi-file
  drop → batch conversion → ZIP download, corrupt-input failure surfacing);
- `web-ts/e2e-python/batch.spec.ts` drives the real UI against the FastAPI
  server (browse modal → folder conversion via SSE → ZIP download).
The corpus mixes happy paths (every format, nested dirs) with sad paths
(corrupt file), a hidden dir and a same-stem collision pair.

For realistic large-scale runs there is also an optional **500-photo dataset**
(`tests/e2e/real_images/`, gitignored) downloaded on demand — rate-limited,
idempotent and never deleted — by `tests/e2e/download_real_dataset.py`. The
gated realistic tests exercise it automatically and capture **performance
metrics** into `tests/e2e/perf-results.json` (gitignored); a dedicated
Python-vs-Rust benchmark lives at `tests/e2e/run_realistic_bench.py`. Suites
run the CLIs with `--no-log` inside disposable temp dirs, so a green run leaves
no `pictowebp.log`, temp corpora, or output folders behind — only the
gitignored perf JSON.

## Non-negotiable privacy guarantees

These are the product's core selling points — never break them:

- **No network calls, no telemetry, no analytics, no cookies, no external
  assets** (fonts/CDNs) in any edition. The Python web UI binds `127.0.0.1`.
- `web-ts/vite.config.ts` injects a strict build-time CSP. The static build is
  `default-src 'none'; connect-src 'none'; ...` (no network at all); the
  `build:python` profile relaxes only `connect-src` to `'self'` so the SPA can
  reach the local API. Do not weaken the static build's policy.
- EXIF/GPS metadata is stripped by default everywhere; the browser backend
  cannot preserve it at all (canvas decoding), so the `metadataControl`
  capability is false there and the toggle is hidden.
- No image data is ever persisted; local storage holds only stats/history.

## Behavioral parity

Features shared across editions — keep them consistent when changing one:

- Same-stem collisions (e.g. `a.png` + `a.jpg` → `a.webp`) are skipped and
  reported, never silently overwritten.
- Hidden (dot-prefixed) directories are skipped during enumeration.
- Output folder per run is unique (`<source>_webp_<timestamp>`); files are
  written crash-safe (only fully converted files appear).
- Browser canvas limits are clamped in `web-ts/src/core.ts`
  (`clampToCanvasLimits`) — oversized inputs downscale instead of failing.
- There is **one** web UI: `web-ts/`. `main.ts` only talks to the
  `ConversionBackend` interface in `web-ts/src/backend/` — never to HTTP or
  to the worker pool directly. Capabilities (`backend/capabilities`) decide
  which controls render (lossless/metadata/open-folder are python-only).
  Add features to the shared UI + both backends, never fork a second UI.
- The stylesheet lives at `web-ts/src/ui.css` (imported by `main.ts` and
  bundled into both build profiles). Restyle there only — never in a separate
  UI. No external assets (fonts/CDNs).
- All event wiring uses `addEventListener` (no inline handlers) so the strict
  CSP never needs `unsafe-inline` for scripts.
- The UI must stay behaviorally consistent across backends: full-window
  drag-and-drop overlay, keyboard-operable drop zones, `aria-live` toasts,
  quality slider `aria-valuetext`, and a light/dark theme driven purely by
  CSS tokens (`prefers-color-scheme`) in `ui.css`.
- TS conversions run in an OffscreenCanvas worker pool
  (`web-ts/src/worker.ts`, pooled in `converter.ts`); the main-thread path is
  a fallback — keep both working. Canvas-limit clamping lives in `core.ts`
  because the worker imports it.

## Conventions

- Tone: fun and emoji-friendly in user-facing copy and docs; plain and minimal
  in code and commit messages.
- Commit style: conventional, scoped (e.g. `feat(web-ts): ...`,
  `fix(web): ...`).
- Dependencies are locked (`uv.lock`, `Cargo.lock`, `package-lock.json`) —
  commit lockfile changes alongside `pyproject.toml`/`Cargo.toml`/
  `package.json`.
- Never commit secrets or log files (`pictowebp.log` is gitignored).

## Deployment

- Pushing to `main` with changes under `web-ts/**` (or the workflow file)
  triggers `.github/workflows/deploy-web-ts.yml`: npm ci → test → build → CSP
  verification → GitHub Pages publish at `https://aditya-xq.github.io/PicToWebP/`.
  The static profile (`npm run build`) is the deploy artifact.
- The workflow requires repo Actions permissions set to *Allow all actions*
  (not `local_only`) and Pages source *GitHub Actions*; the `github-pages`
  environment has a branch policy for `main`.
- `vite.config.ts` sets `base: '/PicToWebP/'` for the static profile — don't
  remove it, the site breaks on Pages without it. The `python` profile uses
  `base: '/'` and is served by `pictowebp-web` from `web-ts/dist-python`.

## More info

See `CONTRIBUTING.md` for the full project layout, CLI/API reference, and PR
guidelines. See `BENCHMARK.md` for the Python-vs-Rust performance write-up.

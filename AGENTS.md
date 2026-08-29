# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

PicToWebP converts images (JPG/PNG/WebP, plus BMP/TIFF/GIF in Python) to WebP,
bulk or single, in three independent implementations:

- `src/pictowebp/` — Python CLI + FastAPI web UI (uvicorn, binds `127.0.0.1`)
- `src_rust/` — Rust CLI (rayon, edition 2024)
- `web-ts/` — browser-only edition (Vite + TypeScript, zero backend)

The two CLIs intentionally share the same flags and behavior. The browser
edition matches the Python web UI's experience.

## Commands

```bash
# Python (use uv; venv lives in .venv)
uv sync
uv run ruff check src tests
uv run ruff format --check src tests
uv run pytest

# Rust
cd src_rust && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test

# Browser edition
cd web-ts && npm test && npm run build   # build runs tsc (typecheck)
```

All suites are expected green before committing (currently 80 pytest, 33 cargo
test, 16 vitest).

## Non-negotiable privacy guarantees

These are the product's core selling points — never break them:

- **No network calls, no telemetry, no analytics, no cookies, no external
  assets** (fonts/CDNs) in any edition. The Python web UI binds `127.0.0.1`.
- `web-ts/vite.config.ts` injects a strict build-time CSP
  (`default-src 'none'; connect-src 'none'; ...`). Do not weaken it.
- EXIF/GPS metadata is stripped by default everywhere; the browser edition
  cannot preserve it at all (canvas decoding).
- No image data is ever persisted; local storage holds only stats/history.

## Behavioral parity

Features shared across editions — keep them consistent when changing one:

- Never upscale on resize; aspect ratio preserved; side limit 16–16384 px.
- Same-stem collisions (e.g. `a.png` + `a.jpg` → `a.webp`) are skipped and
  reported, never silently overwritten.
- Hidden (dot-prefixed) directories are skipped during enumeration.
- Output folder per run is unique (`<source>_webp_<timestamp>`); files are
  written crash-safe (only fully converted files appear).
- Browser canvas limits are clamped in `web-ts/src/converter.ts`
  (`clampToCanvasLimits`) — oversized inputs downscale instead of failing.
- Both web UIs share one stylesheet: `src/pictowebp/templates/ui.css`
  (Python serves it at `/static/ui.css`; web-ts bundles it via import in
  `main.ts`). Restyle both UIs there only — never one independently. The
  Python UI must load no external assets (Tailwind CDN and web fonts were
  removed).

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
- The workflow requires repo Actions permissions set to *Allow all actions*
  (not `local_only`) and Pages source *GitHub Actions*; the `github-pages`
  environment has a branch policy for `main`.
- `vite.config.ts` sets `base: '/PicToWebP/'` — don't remove it, the site
  breaks on Pages without it.

## More info

See `CONTRIBUTING.md` for the full project layout, CLI/API reference, and PR
guidelines.

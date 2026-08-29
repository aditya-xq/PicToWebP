# PicToWebP 🖼️➡️🌐

<img src="https://github.com/aditya-xq/PicToWebP/assets/32733783/8cdc0fd6-109e-4161-b63e-0632e477d105" alt="PicToWebP Logo" width="250" height="250">

**PicToWebP** bulk-converts your chunky images into lightweight WebP beauties — from a CLI or your browser. In many collections it cuts file sizes by **90%+** with no visible quality loss.

## Why Should You Care? 🤔

Images are like cats on the internet: everywhere. But unlike cats, heavy images slow down your site, eat storage, and make users wait. WebP files are dramatically smaller than JPEG/PNG at equivalent quality, which means:

1. **Smaller size, same quality** — WebP beats JPEG/PNG on compression.
2. **Faster websites** — fewer bytes, zippier loads.
3. **Lower storage costs** — thousands of saved images add up to real money. 💰
4. **Happier planet** — less server power. 🌍

## Privacy First 🔒

Every edition was audited to be private by architecture, not by policy:

- **Nothing leaves your machine.** The browser edition has no server at all; the Python web UI binds to `127.0.0.1` only. Images are never uploaded anywhere — there is nothing to upload *to*.
- **Zero network calls.** No analytics, telemetry, cookies, CDN scripts, or external fonts. The browser edition ships a strict `Content-Security-Policy` (`default-src 'none'; script-src 'self'; connect-src 'none'`) injected at build time — even a compromised dependency could not phone home.
- **EXIF/GPS stripped by default** in all editions (and browser decoding cannot preserve it at all).
- **No image data is ever persisted.** The browser edition keeps results in memory and releases the blobs after you export them; its local history stores only names and sizes.

Try the browser edition live — it's deployed to GitHub Pages, fully static:

**https://aditya-xq.github.io/PicToWebP/**

## Features 🚀

- **Recursive folder conversion** with the source directory structure preserved.
- **Uses every CPU core** — Python and Rust both convert many images at once.
- **Live progress bar** with elapsed time, ETA, and per-image updates.
- **Rich savings report** at the end of every run (bytes saved, % reduction, time).
- **Detailed failure report** — every file that couldn't be converted is grouped by reason, listed on screen, and saved to `conversion-errors.txt` inside the output folder.
- **Categorized errors** (`Corrupt or mislabeled image`, `Unreadable file`, `Permission denied`, `Output write failed`, `Conversion failed`) so you know what to fix.
- **Lossless WebP encoding** alongside the usual quality-based mode.
- **Metadata handling** — strip EXIF (the default, best for the web) or keep it, per run.
- **Optional resizing** — set a maximum width and/or height; images are never enlarged, only shrunk, and aspect ratio is preserved.
- **Live savings counter** — the progress bar shows bytes saved and skipped files as they happen.
- **Graceful cancellation** — press `Ctrl+C` once to stop and keep everything already converted; press twice to stop immediately (exit code `130`).
- **One-keystroke finish** — after a successful run in a real terminal, PicToWebP offers to open the output folder for you (`[Y/n]`).
- **Same-stem collision detection** — inputs like `photo.png` and `photo.jpg` that would write to the same `photo.webp` are reported as failures, not silently overwritten.
- **Crash-safe writing** — a `.webp` only appears once it's fully converted, so an interrupted run never leaves half-written images next to your photos.
- **Unique output folder names** — every run gets a fresh `<source>_webp_<timestamp>` directory next to the source; back-to-back runs never clash.
- **Pretty colored output** — colors in the terminal, plain text when piped or when `NO_COLOR=1` is set.
- **Local web UI** (Python) with a live progress view, folder browser, and one-click image upload.
- **Browser-only edition** (TypeScript) — the same experience with **zero installs**: conversion happens entirely in your browser via the File System Access API, so images never touch a server (or even a local one).
- **Two implementations, one workflow** — pick Python or Rust, the output is interchangeable.

## Supported Formats 🎨

- **Both CLIs:** JPG, PNG, WebP (including WebP sources being re-encoded smaller).
- **Python CLI additionally:** BMP, TIFF, GIF.

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
│       └── index.html
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
        ├── converter.ts      # Canvas → WebP encoding, folder enumeration
        └── core.ts           # pure logic: collisions, resize math, formatting
```

## Quick Start 🏁

### Python CLI

Requires Python 3.10+. Using [uv](https://docs.astral.sh/uv/) (recommended):

```bash
uv sync
uv run pictowebp path/to/images -q 85 -t 8
```

Or with pip:

```bash
pip install .
pictowebp path/to/images -q 85 -t 8
```

Run without arguments for an interactive session (it will prompt for the folder,
quality and thread count — just press `Enter` to accept the defaults). Pasted
paths with surrounding quotes or a leading `~` work too. Every run creates a
fresh `images_webp_<timestamp>` folder next to the source, mirroring its
structure.

#### CLI flags

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

#### Exit codes

| Code | Meaning |
| ---- | ------------------------------------------------------------------------ |
| `0`  | At least one file was converted successfully (skipped files are reported as warnings, not errors). |
| `2`  | The source folder does not exist or is not a directory. |
| `3`  | Every file failed to convert — a hard failure, no output produced. |

Pressing `Ctrl+C` stops the run gracefully: everything already converted is
kept, the summary is printed, and the exit code is `0` (or `3` if nothing
converted). Pressing `Ctrl+C` a second time exits immediately with code `130`.

### Web UI

```bash
pictowebp-web            # serves http://127.0.0.1:8000
```

Prefer containers? 🐳

```bash
docker build -t pictowebp .
docker run --rm -p 8000:8000 pictowebp
```

The server also exposes a small JSON API. Only one conversion runs at a time; concurrent requests get `429 Too Many Requests`.

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

Example:

```bash
curl -X POST http://127.0.0.1:8000/convert \
  -H "Content-Type: application/json" \
  -d '{"source_folder": "C:/path/to/images", "quality": 85, "threads": 8, "lossless": false, "strip_metadata": true}'
```

### Browser Edition (TypeScript)

Same look and feel as the web UI above, but with **no backend at all** —
images are decoded and re-encoded by your browser's own WebP encoder, and
files are read/written directly from disk via the File System Access API.

```bash
cd web-ts
npm install
npm run dev            # dev server
npm run build          # production build into dist/ (CSP injected, base path set for Pages)
npm test               # unit tests for the conversion logic
```

Deployment is automatic: a GitHub Actions workflow (`.github/workflows/deploy-web-ts.yml`) builds and tests the browser edition on every push to `main` and publishes it to GitHub Pages.

Highlights:

- **Nothing leaves your machine** — there is no server to trust, because there is no server.
- **Hardened by a security audit** — strict build-time CSP, no remote origins, memory-conscious blob cleanup, and safe handling of oversized or corrupt images (browser canvas limits are clamped instead of silently failing).
- **Pick a folder** (or drag one in) and the whole tree is converted with the structure preserved; save results back to any folder or download a ZIP.
- **Single-image mode** with instant preview and a before/after size comparison — you can also just paste an image with `Ctrl+V`.
- Live progress with ETA, savings stats, a shareable stats image, and conversion history (stored locally in your browser).
- Same-stem collisions (e.g. `photo.png` + `photo.jpg`) are skipped and reported instead of silently overwritten, just like the CLIs.

Honest limitations of doing everything in the browser:

- Metadata (EXIF/GPS) is **always stripped** — canvas decoding cannot preserve it. For keep-metadata workflows, use the Python or Rust CLI.
- There is no separate lossless mode; use the quality slider at 100 for the best the browser encoder offers.
- Requires a Chromium-based browser (Chrome/Edge) for folder access; single-image mode works anywhere WebP encoding is supported.

### Rust CLI

Requires Rust 1.85+ (edition 2024):

```bash
cd src_rust
cargo run --release
```

Or install it permanently:

```bash
cargo install --path src_rust
pictowebp   # then follow the prompts
```

#### CLI flags

The Rust CLI exposes the same surface as the Python one (minus `--no-log`, which has no analogue):

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

## Sample Output

```
  PicToWebP
  Bulk Image to WebP Converter

  Found 2,598 images (1.70 GB)

  ────────────────────────────────────────────────────────────────
   Configuration
  ────────────────────────────────────────────────────────────────

  Source:  C:\photos\vacation
  Output:  C:\photos\vacation_webp_20260828_224012
  Quality: 80
  Threads: 16
  Mode: lossy
  Metadata: strip
  Resize: original

  ────────────────────────────────────────────────────────────────
   Conversion Complete (with errors)
  ────────────────────────────────────────────────────────────────

  Output folder: C:\photos\vacation_webp_20260828_224012
  Images converted: 2,590/2,598
  Memory reduced: 1463.17 MB (85.79%)
  Time taken: 46.1s

  ────────────────────────────────────────────────────────────────
   Files Not Converted (8)
  ────────────────────────────────────────────────────────────────

  Corrupt or mislabeled image: Error parsing image. Illegal start bytes:8950 (5)
    C:\photos\vacation\IMG_20151102_232523.JPG
    C:\photos\vacation\IMG_20151102_232544.JPG
    C:\photos\vacation\IMG_20151102_232606.JPG
    C:\photos\vacation\IMG_20151102_233809.JPG
    C:\photos\vacation\IMG_20160216_200717.JPG

  Corrupt or mislabeled image: Invalid PNG signature. (2)
    C:\photos\vacation\Screenshot_2017-08-24-18-45-49.png
    C:\photos\vacation\Screenshot_2017-10-01-16-25-39.png

  Corrupt or mislabeled image: unexpected end of file
    C:\photos\vacation\Screenshot_2018-08-08-19-27-32.png

  Error report: C:\photos\vacation_webp_20260828_224012\conversion-errors.txt
  ────────────────────────────────────────────────────────────────
  Open the output folder? [Y/n]
```

The same file list is also written to `conversion-errors.txt` in the output folder so it can be reviewed or piped into other tools later. The exit code is `0` because the run produced 2,590 successful outputs; the eight failures are warnings that the caller can act on.

## Failure report format

```
PicToWebP conversion errors

[Corrupt or mislabeled image] Invalid PNG signature.
C:\photos\Screenshot_2017-08-24-18-45-49.png

[Corrupt or mislabeled image] unexpected end of file
C:\photos\Screenshot_2018-08-08-19-27-32.png
```

Every entry is two lines: a `[Category]` line with the error reason, then the full path. Paths are stripped of the Windows verbatim `\\?\` prefix for readability.

## Development 🛠️

```bash
# Python: format, lint, test
uv sync
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
```

All test suites are expected to be green before submitting changes:

- `python -m pytest` — **80 tests** covering the CLI, conversion engine, progress tracker, image utilities, ANSI styling, FastAPI endpoints, and end-to-end flows.
- `cargo test` — **33 tests** covering the conversion engine end-to-end (successes, failures, collisions, cancellation), resize behavior, EXIF embedding, atomic file writes, error report persistence, and CLI argument validation.
- `npm test` (in `web-ts/`) — **16 tests** covering collision detection, resize math (never upscales), output-name handling, and formatting helpers.

Dependencies are declared in `pyproject.toml` (locked via `uv.lock`), `src_rust/Cargo.toml` (locked via `Cargo.lock`), and `web-ts/package.json` (locked via `package-lock.json`).

## Final Words 🎤

If you're tired of images taking up more space than they should, put them on the
PicToWebP diet: they lose the weight but keep the charm. Feedback and PRs are
always welcome — drop by the Issues section! 💌

---

P.S. No cats were harmed in the making of this tool. They were too busy ruling the internet. 🐈‍⬛

## License

[MIT](LICENSE) © 2026 aditya-xq

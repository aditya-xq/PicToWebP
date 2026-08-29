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

PicToWebP is private by architecture, not by policy:

- **Nothing ever leaves your machine.** The browser edition has no server at all; the Python web UI runs on `127.0.0.1` only. There is nothing to upload *to*.
- **No tracking.** No analytics, no cookies, no telemetry, no accounts.
- **EXIF/GPS stripped by default** — camera info and location tags are removed from every converted file (the browser edition can't preserve them at all).

No install? No problem — use it right now:

**https://aditya-xq.github.io/PicToWebP/**

## Features 🚀

- **Bulk convert** — pick a folder and every image inside (including subfolders) is converted, with the directory structure preserved.
- **Single-image convert** — drop one image, get its WebP instantly.
- **Drag anywhere** — drop files or folders on any part of the window; a full-screen overlay catches them.
- **Automatic light & dark theme** — follows your OS preference, no toggle needed.
- **Uses every CPU core** — Python and Rust convert many images at once; the browser edition converts off the main thread so the UI never stutters.
- **Live progress bar** with elapsed time, ETA, and per-image updates.
- **One-click ZIP download** of the converted results (browser edition and web UI).
- **Rich savings report** at the end of every run (bytes saved, % reduction, time).
- **Detailed failure report** — anything that couldn't be converted is listed on screen and saved to `conversion-errors.txt`.
- **Optional resizing** — set a maximum width and/or height; images are never enlarged, only shrunk, and aspect ratio is preserved.
- **Metadata handling** — strip EXIF (the default, best for the web) or keep it, per run.
- **Graceful cancellation** — stop mid-run and keep everything already converted.
- **Same-stem collision detection** — inputs like `photo.png` and `photo.jpg` that would write to the same `photo.webp` are reported, not silently overwritten.
- **Crash-safe writing** — a `.webp` only appears once it's fully converted, so an interrupted run never leaves half-written images next to your photos.
- **Lossless WebP encoding** (Python & Rust) alongside the usual quality-based mode.

## Supported Formats 🎨

- **Both CLIs:** JPG, PNG, WebP (including WebP sources being re-encoded smaller).
- **Python CLI additionally:** BMP, TIFF, GIF.

## Quick Start 🏁

### Browser Edition — zero install 🌐

The fastest way in: open **https://aditya-xq.github.io/PicToWebP/** and you're converting.

- **Bulk:** click to select a folder (or drag one in) — the whole tree is converted with structure preserved. Save results back to any folder or download a ZIP.
- **Single:** drop an image, paste one with `Ctrl+V`, or click to browse — instant preview and a before/after size comparison.
- Nothing to install, nothing to sign up for. Prefer to run it yourself? `cd web-ts && npm install && npm run dev`.

Honest limitations of doing everything in the browser:

- Metadata (EXIF/GPS) is **always stripped** — canvas decoding cannot preserve it. For keep-metadata workflows, use the Python or Rust CLI.
- There is no separate lossless mode; use the quality slider at 100 for the best the browser encoder offers.
- Requires a Chromium-based browser (Chrome/Edge) for folder access; single-image mode works anywhere WebP encoding is supported.

### Python 🐍

Requires Python 3.10+. Using [uv](https://docs.astral.sh/uv/) (recommended):

```bash
uv sync
uv run pictowebp path/to/images -q 85
```

Or with pip:

```bash
pip install .
pictowebp path/to/images -q 85
```

Run without arguments for an interactive session (it will prompt for the folder,
quality and thread count — just press `Enter` to accept the defaults). Every run
creates a fresh `images_webp_<timestamp>` folder next to the source, mirroring
its structure. Quality defaults to `80`; add `--lossless` to keep every pixel.

Prefer converting in your browser but with Python's format support? Serve the local web UI:

```bash
pictowebp-web            # serves http://127.0.0.1:8000
```

Prefer containers? 🐳

```bash
docker build -t pictowebp .
docker run --rm -p 8000:8000 pictowebp
```

### Rust 🦀

Requires Rust 1.85+ (edition 2024):

```bash
cargo install --path src_rust
pictowebp   # then follow the prompts
```

The Rust CLI exposes the same flags and behaviour as the Python one (`-q`, `-t`,
`--lossless`, `--keep-metadata`, `--resize-width/height`, ...). Run
`pictowebp --help` for the full list.

## Sample Output

```
  PicToWebP
  Bulk Image to WebP Converter

  Found 2,598 images (1.70 GB)

   Configuration

  Source:  C:\photos\vacation
  Output:  C:\photos\vacation_webp_20260828_224012
  Quality: 80
  Threads: 16

   Conversion Complete (with errors)

  Output folder: C:\photos\vacation_webp_20260828_224012
  Images converted: 2,590/2,598
  Memory reduced: 1463.17 MB (85.79%)
  Time taken: 46.1s

   Files Not Converted (8)

  (grouped by reason — corrupt files, permission issues, ...)

  Error report: C:\photos\vacation_webp_20260828_224012\conversion-errors.txt
  Open the output folder? [Y/n]
```

That's an **85.79% reduction** across 2,598 images in 46 seconds. The eight
failures are grouped by reason, listed on screen, and saved to
`conversion-errors.txt` so nothing fails silently.

## Final Words 🎤

If you're tired of images taking up more space than they should, put them on the
PicToWebP diet: they lose the weight but keep the charm. Feedback and PRs are
always welcome — drop by the Issues section! 💌

Want to hack on PicToWebP? See [CONTRIBUTING.md](CONTRIBUTING.md).

---

P.S. No cats were harmed in the making of this tool. They were too busy ruling the internet. 🐈‍⬛

## License

[MIT](LICENSE) © 2026 aditya-xq

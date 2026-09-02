# PicToWebP 🖼️➡️🌐

<p align="center">
  <img src="https://github.com/aditya-xq/PicToWebP/assets/32733783/8cdc0fd6-109e-4161-b63e-0632e477d105" alt="PicToWebP Logo" width="250" height="250">
</p>

**PicToWebP** bulk-converts your chunky images into lightweight WebP beauties, from a CLI or your browser. In many collections it cuts file sizes by **90%+** with no visible quality loss.

## Why Should You Care? 🤔

Images are like cats on the internet: everywhere. But unlike cats, heavy images slow down your site, eat storage, and make users wait. WebP files are dramatically smaller than JPEG/PNG at equivalent quality, which means:

1. **Smaller size, same quality**: WebP beats JPEG/PNG on compression.
2. **Faster websites**: fewer bytes, zippier loads.
3. **Lower storage costs**: thousands of saved images add up to real money. 💰
4. **Happier planet**: less server power. 🌍

## Privacy First 🔒

PicToWebP is private by architecture, not by policy:

- **Nothing ever leaves your machine.** The browser edition has no server at all; the Python web UI runs on `127.0.0.1` only. There is nothing to upload *to*.
- **No tracking.** No analytics, no cookies, no telemetry, no accounts.
- **EXIF/GPS stripped by default**: camera info and location tags are removed from every converted file (the browser edition can't preserve them at all).

No install? No problem, use it right now:

**https://aditya-xq.github.io/PicToWebP/**

## Features 🚀

- **Bulk convert**: pick a folder and every image inside (including subfolders) is converted, with the directory structure preserved.
- **Single-image convert**: drop one image, get its WebP instantly, with a draggable before/after comparison slider.
- **One-click ZIP download** of the converted results, named `<source>_webp_<timestamp>.zip` to match the CLI output folder.
- **Shareable stats card**: after a conversion, generate an image of your savings for social sharing.
- **Detailed failure report**: anything that couldn't be converted is listed on screen and saved to `conversion-errors.txt`.
- **Metadata handling**: strip EXIF (the default, best for the web) or keep it, per run.
- **Graceful cancellation**: stop mid-run and keep everything already converted.
- **Same-stem collision detection**: inputs like `photo.png` and `photo.jpg` that would write to the same `photo.webp` are reported, not silently overwritten.
- **Crash-safe writing**: a `.webp` only appears once it's fully converted, so an interrupted run never leaves half-written images next to your photos.

## Supported Formats 🎨

- **Both CLIs:** JPG, PNG, WebP (including WebP sources being re-encoded smaller).
- **Python CLI additionally:** BMP, TIFF, GIF.

## Quick Start 🏁

### Browser Edition: zero install 🌐

The fastest way in: open **https://aditya-xq.github.io/PicToWebP/** and you're converting.

- **Bulk:** click to select a folder (or drag one in) and the whole tree is converted with structure preserved. Save results back to any folder or download a ZIP.
- **Single:** drop an image, paste one with `Ctrl+V`, or click to browse. You get an instant 1:1 preview with a before/after comparison slider.
- Nothing to install, nothing to sign up for.

Prefer to run it yourself? 🏠

```bash
cd web-ts
npm install
npm run build     # the exact GitHub Pages artifact (browser backend → dist/)
npm run preview   # serve it at http://localhost:4173/PicToWebP/
```

(The `/PicToWebP/` subpath is intentional: the static build is rooted there to
match the Pages URL.) For live reload while hacking, use `npm run dev` and open
`http://localhost:3000/PicToWebP/`.

Honest limitations of doing everything in the browser:

- Metadata (EXIF/GPS) is **always stripped**: canvas decoding cannot preserve it. For keep-metadata workflows, use the Python or Rust CLI.
- There is no separate lossless mode; use the quality slider at 100 for the best the browser encoder offers.
- Requires a Chromium-based browser (Chrome/Edge) for folder access; single-image mode works anywhere WebP encoding is supported.

### Python 🐍

Requires Python 3.10+. Using [uv](https://docs.astral.sh/uv/) (recommended):

```bash
uv sync
uv run pictowebp path/to/images -q 85
```

Or with pip (CLI only; install `.[web]` if you also want the local web UI):

```bash
pip install .
pictowebp path/to/images -q 85
```

Run without arguments for an interactive session (it will prompt for the folder,
quality and thread count; just press `Enter` to accept the defaults). Every run
creates a fresh `images_webp_<timestamp>` folder next to the source, mirroring
its structure. Quality defaults to `80`; add `--lossless` to keep every pixel.

Prefer converting in your browser but with Python's format support? Serve the local web UI (requires the `web` extra):

```bash
pip install .[web]
pictowebp-web            # serves http://127.0.0.1:8000
```

Prefer containers? 🐳

```bash
docker build -t pictowebp .
docker run --rm -p 8000:8000 pictowebp
```

### Rust 🦀 (for best performance and heavy workloads)

Requires Rust 1.85+ (edition 2024):

```bash
cargo install --path src_rust
pictowebp   # then follow the prompts
```

The Rust CLI exposes the same flags and behaviour as the Python one (`-q`, `-t`,
`--lossless`, `--keep-metadata`, ...). Run
`pictowebp --help` for the full list.

In one real-world run it delivered an **85.79% reduction** across 2,598 images
in 46 seconds. Failures are grouped by reason, listed on screen, and saved to
`conversion-errors.txt` so nothing fails silently.

## Final Words 🎤

If you're tired of images taking up more space than they should, put them on the
PicToWebP diet: they lose the weight but keep the charm. Feedback and PRs are
always welcome, drop by the Issues section! 💌

Want to hack on PicToWebP? See [CONTRIBUTING.md](CONTRIBUTING.md). Curious
about what the test suite covers and how to run it? See
[TESTING.md](TESTING.md). Wonder how the Python and Rust engines stack up?
Read the [benchmark](BENCHMARK.md).

---

P.S. No cats were harmed in the making of this tool. They were too busy ruling the internet. 🐈‍⬛

## License

[MIT](LICENSE) © 2026 aditya-xq

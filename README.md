# PicToWebP 🖼️➡️🌐

<p align="center">
  <img src="https://github.com/aditya-xq/PicToWebP/assets/32733783/8cdc0fd6-109e-4161-b63e-0632e477d105" alt="PicToWebP Logo" width="250" height="250">
</p>

**PicToWebP** bulk-converts your chunky images into lightweight WebP beauties, from a CLI or your browser. In many collections it cuts file sizes by **80%+** with no visible quality loss.

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

**https://xqbuilds.com/pictowebp**

## Features 🚀

- **Bulk convert**: pick a folder and every image inside (including subfolders) is converted, with the directory structure preserved.
- **Single-image convert**: drop one image, get its WebP instantly, with a draggable before/after comparison slider.
- **Shareable stats card**: after a conversion, generate an image of your savings for social sharing.
- **Detailed failure report**: anything that couldn't be converted is listed on screen and saved to `conversion-errors.txt`.
- **Metadata handling**: strip EXIF (the default, best for the web) or keep it, per run.
- **Graceful cancellation**: stop mid-run and keep everything already converted.

And tons of optimizations, edge cases handled, and performance tweaks to give the best experience to you!

## Quick Start 🏁

### Browser Edition: zero install 🌐

The fastest way in: open **https://xqbuilds.com/pictowebp** and you're converting.

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

Requires Python 3.11+ (3.10 is end-of-life and cannot run the patched Pillow 13). Using [uv](https://docs.astral.sh/uv/) (recommended):

```bash
uv sync
uv run pictowebp path/to/images -q 85
```

Or with pip (from this checkout; the Python package is not published on PyPI;
install `.[web]` if you also want the local web UI):

```bash
pip install .
pictowebp path/to/images -q 85
```

Run without arguments for an interactive session (it will prompt for the folder,
quality and thread count; just press `Enter` to accept the defaults). Every run
creates a fresh `images_webp_<timestamp>` folder next to the source, mirroring
its structure. Quality defaults to `80`; add `--lossless` to keep every pixel.

Prefer converting in your browser but with Python's format support? Serve the local web UI (requires the `web` extra, and the SPA has to be built once first):

```bash
cd web-ts && npm run build:python && cd ..   # builds the UI the server serves
pip install .[web]
pictowebp-web            # serves http://127.0.0.1:8000
```

Prefer containers? 🐳

```bash
docker build -t pictowebp .
docker run --rm -p 127.0.0.1:8000:8000 pictowebp
```

The port is published to loopback so the server is never reachable from your
network.

### Rust 🦀 (for best performance and heavy workloads)

Requires Rust 1.85+ (edition 2024):

```bash
cargo install --path src_rust
pictowebp   # then follow the prompts
```

The Rust CLI exposes the same flags and behaviour as the Python one (`-q`, `-t`,
`--lossless`, `--keep-metadata`, ...). Run
`pictowebp --help` for the full list.

Prebuilt releases for Windows (x64/ARM64), Linux (x64/ARM64 musl), and macOS
(x64/ARM64) are on the [Releases](https://github.com/aditya-xq/PicToWebP/releases)
page; the [agent installers](agent/) verify SHA-256 and Sigstore attestations.

Input formats are JPEG, PNG, and WebP (Python also reads BMP/TIFF/GIF).
HEIC/HEIF, DNG/ProRAW, AVIF, and JPEG XL are not supported; export those as
JPEG or PNG first.

In one real-world run it delivered an **85.79% reduction** across 2,598 images
in 46 seconds. Failures are grouped by reason, listed on screen, and saved to
`conversion-errors.txt` so nothing fails silently.

### For AI agents and coding assistants 🤖

PicToWebP ships an agent-facing contract, an installable skill, and a local MCP
server, so an assistant can install it, run it, and read the result without
scraping terminal output:

```bash
pictowebp ./public/images --json --no-progress -q 82
pictowebp ./hero.png --json          # single image
pictowebp . --json --dry-run         # plan only, writes nothing
pictowebp --info --json              # edition, version, capabilities
pictowebp --mcp                      # stdio MCP server (Rust 0.4.0+)
```

`--json` keeps stdout to exactly one object and routes human output to stderr.
Runs never prompt when stdio is not a terminal, so a scripted call cannot hang.

- Point your agent at **[`agent/`](agent/)** — a self-contained skill with
  installers, flag reference, machine-readable schemas, and guardrails.
- Install the skill into Claude Code, Codex, Cursor, opencode or any other
  supported agent in one line:
  `npx skills add https://aditya-xq.github.io/PicToWebP/`
- [`llms.txt`](llms.txt) is a compact entry point for crawlers and assistants,
  and [`llms-full.txt`](https://aditya-xq.github.io/PicToWebP/llms-full.txt)
  concatenates the contract and every reference for agents that prefer one
  fetch. Schemas are indexed at
  [`agent/pictowebp/schemas/index.json`](agent/pictowebp/schemas/index.json).
- opencode users can add the hosted catalog in one line:
  `"skills": ["https://aditya-xq.github.io/PicToWebP/agent/"]`
- The normative contract lives in
  [`docs/agent-contract.md`](docs/agent-contract.md).
- The converter itself stays offline; only the installer downloads a release,
  and it verifies SHA-256 and, when `gh` is available, a Sigstore attestation
  before installing.

### Agent quick reference

| Goal | Command |
|------|---------|
| Install (Windows) | `powershell -ExecutionPolicy Bypass -File agent/pictowebp/scripts/install.ps1 -Json` |
| Install (macOS/Linux) | `sh agent/pictowebp/scripts/install.sh --json` |
| Version + features | `pictowebp --info --json` |
| Bulk convert | `pictowebp DIR --json -q 82` |
| Plan first | `pictowebp DIR --json --dry-run` |
| Deterministic output | `pictowebp DIR --json --out DIR-webp` |
| Strict CI signal | `pictowebp DIR --json --fail-on-error` |
| MCP server (Rust) | `pictowebp --mcp` |

Exit codes: `0` ok, `2` bad arguments/path, `3` nothing converted, `4`
failures with `--fail-on-error`, `5` empty with `--fail-on-empty`, `130`
cancelled.

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

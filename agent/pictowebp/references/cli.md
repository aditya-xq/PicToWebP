# CLI reference

Both editions accept the same flags. The contract is normative in
`docs/agent-contract.md`.

## Usage

```
pictowebp [OPTIONS] [PATH]
```

`PATH` is a folder (recursive) or a single image.

## Flags

| Flag | Default | Notes |
|------|---------|-------|
| `-q, --quality N` | `80` | 1–100. Ignored by `--lossless`. |
| `-t, --threads N` | CPU count | 1–256. |
| `--max-pixels N` | `500000000` | Decoded-pixel cap per image; also `PICTOWEBP_MAX_PIXELS`. |
| `--lossless` | off | Overrides quality. |
| `--keep-metadata` | off | Default strips EXIF/GPS. The browser edition cannot keep it. |
| `--no-progress` | auto | Progress is also disabled when stdout is not a TTY. |
| `--report PATH` | `<output>/conversion-errors.txt` | Only written when failures exist. Must stay inside the output folder unless `--allow-report-outside` is set. |
| `--allow-report-outside` | off | Permit `--report` to escape the output folder. |
| `--json` | off | One JSON object on stdout; human output to stderr; implies `--no-progress`. |
| `--info` | off | Metadata + capabilities, then exit. No conversion, no network. |
| `--yes` | off | Never prompt. |
| `--interactive` | off | Force prompts even without a TTY. |
| `--out DIR` | sibling timestamp | Folder runs: must be missing or empty and outside the source; single files may use any empty folder. |
| `--dry-run` | off | Count and detect collisions, write nothing. |
| `--fail-on-error` | off | Exit `4` if anything failed or collided. |
| `--fail-on-empty` | off | Exit `5` if nothing was discovered. |
| `--no-log` | off | Python only. Implied by `--json`. |

## Examples

```bash
# Web assets at a slightly higher quality
pictowebp ./public/img -q 82 -t 4

# One image, scripted
pictowebp ./hero.png --json

# CI with a deterministic destination and a strict failure signal
pictowebp ./assets --json --out ./dist/img --fail-on-error

# Plan a large repo before touching it
pictowebp . --json --dry-run
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (partial failures still succeed by default). |
| 1 | Unexpected internal error. |
| 2 | Invalid arguments, missing source, bad `--out`. |
| 3 | Nothing converted (all inputs failed or collided). Never returned by `--dry-run`. |
| 4 | `--fail-on-error` and at least one failure/collision. |
| 5 | `--fail-on-empty` and zero images discovered. |
| 130 | Cancelled. |

## Behaviour notes

- Same-stem collisions (`a.png` + `a.jpg` → `a.webp`) skip both inputs and
  are reported; nothing is silently overwritten.
- Hidden (dot-prefixed) directories are skipped.
- Output folders are unique per run (`<source>_webp_<timestamp>`) unless
  `--out` is given.
- Files are written crash-safe: only fully converted files appear.
- The Rust edition reads jpg/jpeg/png/webp only. Python also reads bmp/tiff/gif.
- HEIC/HEIF, DNG/ProRAW, AVIF, and JPEG XL are not supported; export them as
  JPEG or PNG first. A single-file run reports `Unsupported format`.
- Images above `--max-pixels` / `PICTOWEBP_MAX_PIXELS` (default 500,000,000
  pixels) are skipped with the `Image too large` category. The default covers
  102 MP medium format, 151 MP digital backs, 200 MP phones, and 400 MP
  multi-shot composites.
- Images above 100 MP are converted one at a time to bound peak memory
  (4 bytes per pixel); use `-t` for the rest.
- Reports stay inside the output folder unless `--allow-report-outside` is set.
- The Python log lives in the per-user state directory, never the working
  directory; `--no-log` or `--json` disables it.

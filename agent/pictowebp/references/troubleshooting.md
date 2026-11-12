# Troubleshooting

## `pictowebp` is not found

The install directory is usually not on `PATH` (the installer deliberately
does not edit it). Use the absolute path printed by the installer, or set:

```bash
export PICTOWEBP_BIN="$HOME/.local/bin/pictowebp"
```

```powershell
$env:PICTOWEBP_BIN = "$env:LOCALAPPDATA\Programs\pictowebp\pictowebp.exe"
```

A shell opened before the install will not see a new `PATH` either.

## Wrong edition found

Both editions install a binary named `pictowebp`. Check:

```bash
pictowebp --info --json
```

`edition` is `rust` or `python`. They share flags but not versions or format
support. Point `PICTOWEBP_BIN` at the one you want.

## Windows: SmartScreen or "operation did not complete"

Downloaded binaries carry the Mark of the Web. The installer clears it with
`Unblock-File`. For a manual download:

```powershell
Unblock-File .\pictowebp.exe
```

## Windows: running a script is blocked

Use an explicit execution policy for that one process:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Do not change the machine-wide policy.

## `Output folder is not empty`

`--out` refuses to merge into an existing directory. Pick a new folder or
remove its contents. This is intentional: a conversion must never overwrite
unrelated files.

## `Output folder must not be inside the source folder`

Writing inside the source tree would make later runs re-discover their own
output. Choose a sibling directory.

## `Output file already exists`

Single-file runs never overwrite. Delete the sibling `.webp` or use `--out`.

## Exit `3` with `converted: 0`

Every input failed or collided during a real run. A `--dry-run` never returns
`3`. Read `failures[]`:

- `Corrupt or mislabeled image` — the file is not the format its extension
  claims. Re-export it from the source application.
- `Permission denied` — the file or destination is locked.
- `Output name collision` — two inputs share a stem (`a.png` + `a.jpg`).
  Convert them separately or rename one.

## HEIC/HEIF, DNG/ProRAW, AVIF or JPEG XL

These formats are not decoded by the current build. A single-file run reports
`Unsupported format`; folders skip them during discovery. Export the image as
JPEG or PNG first (on iPhone: Settings → Camera → Formats → Most Compatible,
or share as JPEG; on Android: export from the gallery/RAW editor).

## `image is too large`

The input exceeds the decoded-pixel cap (500,000,000 by default). This is a
deliberate decompression-bomb guard. Raise it with `--max-pixels` or
`PICTOWEBP_MAX_PIXELS` for legitimate gigapixel images. Images above 100 MP are
already converted one at a time.

## Nothing was discovered

The Rust edition reads `jpg`, `jpeg`, `png`, `webp` only. Python also reads
`bmp`, `tiff`, `gif`. Hidden (dot-prefixed) directories are skipped by design.

## JSON mode shows nothing on stdout

Check that you passed `--json`. Human output goes to stderr in JSON mode, so
redirecting stderr to `/dev/null` should still leave one object on stdout.

## MCP server does not start or respond

`pictowebp --mcp` requires Rust 0.4.0+; confirm `pictowebp --info --json` lists
`mcp` in `capabilities`. The transport is stdio, so stdout must be reserved for
protocol messages; do not wrap it in a shell that prints to stdout. Call
`convert` with an explicit `output_dir` and inspect `counts` and `failures` in
the returned payload.

## Cancelled (`130`)

The first Ctrl+C (or SIGINT) stops after in-flight files finish and still
writes a result object. A second interrupt exits immediately without JSON.

## Large batch looks stuck

Check `--info --json` for `threads`, and pass `-t` explicitly. Multi-process
startup in the Python edition has a fixed cost; the Rust edition is faster on
large trees.

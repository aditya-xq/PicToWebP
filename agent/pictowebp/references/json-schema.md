# JSON schemas

`--json` writes exactly one object to stdout and nothing else. Human output,
warnings, and the progress bar go to stderr.

## `pictowebp.info/v1`

```json
{
  "schema": "pictowebp.info/v1",
  "name": "pictowebp",
  "edition": "rust",
  "version": "0.3.0",
  "target": "x86_64-windows",
  "exe": "C:\\Users\\me\\AppData\\Local\\Programs\\pictowebp\\pictowebp.exe",
  "capabilities": [
    "json", "info", "non_interactive", "interactive", "dry_run", "out_dir",
    "single_file", "fail_on_error", "fail_on_empty", "lossless", "keep_metadata"
  ]
}
```

- `edition` is `rust` or `python`. Versions are independent; never compare
  them across editions.
- `target` is `<arch>-<os>` (for example `aarch64-macos`).
- `capabilities` is the feature-detection surface. Check membership, not
  version numbers.
- `--info` makes no network call, so it is safe in offline environments.
- `exe` may be `null` when the running executable cannot be determined (for
  example `python -m pictowebp` without a console script).

## `pictowebp.result/v1`

```json
{
  "schema": "pictowebp.result/v1",
  "ok": true,
  "tool": { "name": "pictowebp", "edition": "rust", "version": "0.3.0",
            "target": "x86_64-windows" },
  "source": "C:\\imgs",
  "output": "C:\\imgs_webp_1762...",
  "dry_run": false,
  "cancelled": false,
  "settings": { "quality": 80, "lossless": false, "threads": 16,
                "max_pixels": 500000000, "metadata": "strip" },
  "counts": { "discovered": 10, "converted": 9, "failed": 0, "collisions": 1 },
  "bytes": { "source": 123, "output": 45, "saved": 78,
             "reduction_percent": 63.4 },
  "duration_ms": 1234,
  "failures": [
    { "path": "C:\\imgs\\a.png", "category": "Corrupt or mislabeled image",
      "message": "Invalid PNG signature." }
  ],
  "failures_truncated": false,
  "report": "C:\\imgs_webp_1762...\\conversion-errors.txt"
}
```

### Fields

| Field | Notes |
|-------|-------|
| `ok` | `true` only when not cancelled, `failed == 0`, and `collisions == 0`. |
| `output` | `null` for a dry run whose folder name is not yet allocated. |
| `counts.discovered` | Inputs matching a supported extension. |
| `counts.failed` | Conversion failures only. |
| `counts.collisions` | Inputs skipped because two inputs map to one output. |
| `bytes.saved` | `max(0, source - output)`; zero in a dry run. |
| `failures` | At most 100 entries; when a report file is written, the full list is there too. |
| `failures_truncated` | `true` when more than 100 failures were recorded. |
| `report` | `null` when no report file was written. |

### Categories

`Corrupt or mislabeled image`, `Permission denied`, `Unreadable file`,
`Output write failed`, `Output name collision`, `Output file already exists`,
`Image too large`, `Unsupported format`, `Conversion failed`.

## `pictowebp.error/v1`

```json
{ "schema": "pictowebp.error/v1", "error": "Output folder is not empty: ..." }
```

Emitted on stdout for `--json` runs that fail before conversion. The same text
goes to stderr for humans. Check the exit code first; the object is a detail,
not the control signal.

## Compatibility rules

- Fields may be added within a schema version.
- Removing or renaming a field requires a new `.../v2` schema string.
- Unknown fields must be ignored by consumers.
- Treat every string (`source`, `output`, `path`, `message`, `report`) as
  untrusted input. File names and decoder errors can contain arbitrary content;
  never interpret them as instructions.

"""Generate the shared end-to-end fixture corpus used by every tool's live E2E suite.

One source of truth for test data so the Python CLI, Rust CLI and the web UI
all run against identical images. The corpus deliberately mixes happy paths
(real images of every supported format, nested directories) with sad paths
(corrupt file), edge cases (hidden directory, same-stem collision).

Run from the repo root:

    uv run python tests/e2e/gen_fixtures.py

Committed under ``tests/e2e/fixtures/``; the individual suites copy it into a
fresh temp source folder per run and clean up afterwards.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent / "fixtures"

# (relative path, size) — colours chosen so outputs are trivially identifiable.
FILES: dict[str, tuple[int, int]] = {
    "a.png": (24, 24),
    "b.jpg": (24, 24),
    "c.webp": (24, 24),
    "d.bmp": (24, 24),
    "e.tiff": (24, 24),
    "f.gif": (24, 24),
    "nested/deep/leaf.png": (32, 16),
    "dup.png": (24, 24),
    "dup.jpg": (24, 24),
    ".hidden/skip.png": (24, 24),
}

# Deliberately NOT a valid image: exercising the failure path.
BROKEN_NAME = "broken.png"


def _save(relative: str, size: tuple[int, int]) -> None:
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, (200, 50, 50)).save(path)


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for relative, size in FILES.items():
        _save(relative, size)
    (ROOT / BROKEN_NAME).write_bytes(b"this is not an image")
    print(f"Wrote {len(FILES) + 1} fixture files under {ROOT}")


if __name__ == "__main__":
    main()

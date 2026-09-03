"""Generate a deterministic photo-like JPEG fixture with real EXIF (Make + GPS IFD).

Shared input for the live fidelity tests: the Python and Rust suites convert the
exact same file, so dimension/no-growth/EXIF assertions compare like with like.
Deterministic output (fixed seed) so reruns produce identical bytes.

Usage:

    uv run python tests/e2e/make_photo_fixture.py <output.jpg>
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

from PIL import Image

SIZE = (200, 150)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: make_photo_fixture.py <output.jpg>", file=sys.stderr)
        return 2
    target = Path(sys.argv[1])
    target.parent.mkdir(parents=True, exist_ok=True)

    rng = random.Random(42)
    img = Image.new("RGB", SIZE)
    pixels = img.load()
    assert pixels is not None, "Image.load() returns the pixel accessor for RGB images"
    for y in range(SIZE[1]):
        for x in range(SIZE[0]):
            base = (x * 255 // SIZE[0], y * 255 // SIZE[1], 128)
            jitter = tuple(min(255, max(0, c + rng.randint(-6, 6))) for c in base)
            pixels[x, y] = jitter
    img = img.transpose(Image.Transpose.ROTATE_90)  # portrait, like a phone shot

    exif = Image.Exif()
    exif[0x010F] = "PicToWebP Fixture"  # Make
    exif[0x0110] = "Fixture One"  # Model
    gps = exif.get_ifd(0x8825)  # GPSInfo IFD
    gps[1] = "N"
    gps[2] = (37.7667, 46.0, 22.0)  # GPSLatitude
    gps[3] = "E"
    gps[4] = (122.4194, 25.0, 19.0)  # GPSLongitude

    img.save(target, quality=92, exif=exif)
    print(f"wrote {target} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

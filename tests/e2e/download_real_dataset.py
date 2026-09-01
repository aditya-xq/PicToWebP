"""Download a realistic photo set for large-scale live E2E runs.

Fetches real photographs from Lorem Picsum (https://picsum.photos) — the same
Unsplash-backed source behind most placeholder image sets — and re-encodes a
fraction to PNG/WebP with Pillow so every supported format is represented.

Automatic flow (no manual steps):

    uv run python tests/e2e/download_real_dataset.py

* The default set is **500 images** (~60-150 MB) into ``tests/e2e/real_images/``.
* **Idempotent**: if the folder already holds ``--count`` images it exits
  immediately — nothing is re-downloaded and the source data is never deleted.
* **Resumable**: partially downloaded sets only fetch the missing files.
* **Rate-limited**: requests are throttled to ``--rate`` requests/second across
  ``--threads`` workers, and HTTP 429 responses honour ``Retry-After``.

The folder is gitignored on purpose. The live E2E suites call this script
automatically when the set is missing (and skip if the download fails), then
run against a *copy* in a temp dir and clean that copy up — the original
500-image set stays in place for the next run.

    uv run python tests/e2e/download_real_dataset.py --count 500 --rate 5
"""

from __future__ import annotations

import argparse
import io
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

PICSUM = "https://picsum.photos/seed/{seed}/{width}/{height}"
RETRIES = 4
TIMEOUT_SECONDS = 30
# Every N-th image gets a non-JPEG format so the corpus exercises all codecs.
PNG_EVERY = 5
WEBP_EVERY = 7
NESTED_EVERY = 20  # every N-th image lands in nested/deep/ to exercise recursion.
IMAGE_SUFFIXES = frozenset({".jpg", ".jpeg", ".png", ".webp"})


class RateLimiter:
    """Throttle request *starts* so the source service is never hammered."""

    def __init__(self, requests_per_second: float) -> None:
        self._min_interval = 1.0 / max(requests_per_second, 0.1)
        self._lock = threading.Lock()
        self._last = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            sleep_for = self._last + self._min_interval - now
            if sleep_for > 0:
                time.sleep(sleep_for)
            self._last = time.monotonic()


def image_count(out_root: Path) -> int:
    return sum(1 for p in out_root.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES)


def _format_for(index: int) -> str:
    if index % WEBP_EVERY == 0:
        return "webp"
    if index % PNG_EVERY == 0:
        return "png"
    return "jpg"


def _download_jpeg(limiter: RateLimiter, seed: str, width: int, height: int) -> bytes:
    url = PICSUM.format(seed=seed, width=width, height=height)
    last_error: Exception | None = None
    for attempt in range(RETRIES):
        limiter.wait()
        try:
            with urllib.request.urlopen(url, timeout=TIMEOUT_SECONDS) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 429:  # slow down, politely
                retry_after = exc.headers.get("Retry-After")
                wait = (
                    float(retry_after)
                    if retry_after and retry_after.isdigit()
                    else 5.0 * (attempt + 1)
                )
                print(f"  rate-limited (429); waiting {wait:.0f}s", file=sys.stderr)
                time.sleep(wait)
                last_error = exc
                continue
            last_error = exc
        except Exception as exc:  # network blips are expected; retry with jitter
            last_error = exc
            time.sleep(random.uniform(0.5, 2.0))
    raise RuntimeError(f"failed to fetch {url}: {last_error}")


def fetch_one(
    index: int, out_root: Path, width: int, height: int, limiter: RateLimiter
) -> Path | None:
    file_format = _format_for(index)
    relative = (
        f"nested/deep/img_{index:04d}.{file_format}"
        if index % NESTED_EVERY == 0
        else f"img_{index:04d}.{file_format}"
    )
    target = out_root / relative
    if target.exists() and target.stat().st_size > 0:
        return None  # already present — resumable

    jpeg = _download_jpeg(limiter, f"pictowebp-{index}", width, height)
    image = Image.open(io.BytesIO(jpeg)).convert("RGB")
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(__doc__ or "Realistic photo downloader").splitlines()[0]
    )
    parser.add_argument("--count", type=int, default=500, help="number of photos (default: 500)")
    parser.add_argument(
        "--size", type=str, default="800x600", help="photo size WxH (default: 800x600)"
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent / "real_images",
        help="output folder (default: tests/e2e/real_images)",
    )
    parser.add_argument("--threads", type=int, default=4, help="download workers (default: 4)")
    parser.add_argument("--rate", type=float, default=10, help="max requests/second (default: 10)")
    args = parser.parse_args()

    try:
        width, height = (int(part) for part in args.size.lower().split("x"))
    except ValueError:
        print("--size must look like 800x600", file=sys.stderr)
        return 2

    args.out.mkdir(parents=True, exist_ok=True)
    present = image_count(args.out)
    if present >= args.count:
        print(f"Dataset already complete ({present} images) in {args.out} — nothing to download.")
        return 0

    print(
        f"Downloading {args.count - present} missing photos into {args.out} "
        f"({args.threads} workers, {args.rate:.0f} req/s)..."
    )
    limiter = RateLimiter(args.rate)
    downloaded = 0
    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        futures = [
            pool.submit(fetch_one, i, args.out, width, height, limiter) for i in range(args.count)
        ]
        for future in as_completed(futures):
            if future.result() is not None:
                downloaded += 1
            if downloaded > 0 and downloaded % 25 == 0:
                print(f"  downloaded {downloaded}/{args.count}")

    present = image_count(args.out)
    print(
        f"Done: {present} images ready in {args.out} (new: {downloaded}). "
        "The E2E suites will use this set and never delete it."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

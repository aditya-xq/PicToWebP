"""Benchmark the Python and Rust CLIs against the realistic photo set.

Run:

    uv run python tests/e2e/run_realistic_bench.py --runs 3

Pipeline: ensures the 500-photo dataset (auto-downloads, rate-limited, never
deletes it), runs each CLI on a *copy* in a temp dir, captures wall-clock time,
throughput and compression ratio, cleans the copy up, then writes the
comparison into ``tests/e2e/perf-results.json`` (``bench`` section) and prints
a readable table.

Metrics captured: images, source/output MiB, compression %, wall seconds,
images/second, MiB/second, and the tool's own reported time for cross-checking.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from statistics import mean, median
from time import perf_counter
from typing import Any


def _load_perf() -> Any:
    """Load the sibling perf helper without relying on package imports."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "perf", Path(__file__).resolve().parent / "perf.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


perf = _load_perf()

ROOT = Path(__file__).resolve().parents[2]
E2E_DIR = Path(__file__).resolve().parent
REAL_IMAGES = E2E_DIR / "real_images"
DOWNLOAD_SCRIPT = E2E_DIR / "download_real_dataset.py"
RUST_CRATE = ROOT / "src_rust"
RUST_EXE = "pictowebp.exe" if sys.platform == "win32" else "pictowebp"
FLAGS = ["-q", "80", "-t", "2", "--no-progress"]


def ensure_dataset(count: int = 500) -> bool:
    if sum(1 for p in REAL_IMAGES.rglob("*") if p.is_file()) >= count:
        return True
    subprocess.run(
        [sys.executable, str(DOWNLOAD_SCRIPT), "--count", str(count)],
        cwd=ROOT,
        check=True,
        timeout=900,
    )
    return True


def rust_binary() -> Path:
    binary = RUST_CRATE / "target" / "release" / RUST_EXE
    if not binary.is_file():
        print("Building the Rust CLI in release mode (first run)...")
        subprocess.run(["cargo", "build", "--release"], cwd=RUST_CRATE, check=True, timeout=1800)
    return binary


def output_folder(source: Path) -> Path:
    return max(
        (p for p in source.parent.iterdir() if p.is_dir() and p != source),
        key=lambda p: p.name,
    )


def run_tool(label: str, command: list[str], source: Path, runs: int) -> list[dict]:
    results = []
    for run in range(runs):
        work = Path(tempfile.mkdtemp(prefix=f"pw-bench-{label}-")) / "source"
        shutil.copytree(source, work)
        try:
            started = perf_counter()
            proc = subprocess.run(
                [*command, str(work), *FLAGS],
                capture_output=True,
                text=True,
                timeout=1800,
                # Keep any log file (e.g. pictowebp.log) inside the disposable
                # temp dir so it is cleaned up with the corpus, not the repo.
                cwd=work.parent,
            )
            elapsed = perf_counter() - started
            if proc.returncode != 0:
                raise RuntimeError(f"{label} run {run + 1} failed:\n{proc.stdout}\n{proc.stderr}")
            metrics = perf.measure(work, output_folder(work), elapsed, proc.stdout)
            results.append(metrics)
            print(f"  {label} run {run + 1}: {perf.format_line(label, metrics)}")
        finally:
            shutil.rmtree(work.parent, ignore_errors=True)
    return results


def aggregate(label: str, results: list[dict]) -> dict:
    return {
        "tool": label,
        "images": results[0]["images"],
        "threads": 2,
        "runs": len(results),
        "best_wall_seconds": round(min(r["wall_seconds"] for r in results), 2),
        "median_wall_seconds": round(median(r["wall_seconds"] for r in results), 2),
        "best_images_per_second": round(max(r["images_per_second"] for r in results), 2),
        "median_images_per_second": round(median(r["images_per_second"] for r in results), 2),
        "best_mib_per_second": round(max(r["mib_per_second"] for r in results), 2),
        "mean_reduction_pct": round(mean(r["reduction_pct"] for r in results), 1),
        "source_mib": results[0]["source_mib"],
        "output_mib": results[0]["output_mib"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(__doc__ or "PicToWebP CLI benchmark").splitlines()[0]
    )
    parser.add_argument("--runs", type=int, default=3, help="runs per tool (default: 3)")
    args = parser.parse_args()

    print("Ensuring the realistic dataset (500 photos)...")
    ensure_dataset()

    with tempfile.TemporaryDirectory(prefix="pw-bench-corpus-") as tmp:
        source = Path(tmp) / "source"
        shutil.copytree(REAL_IMAGES, source)
        print(
            f"Corpus: {len(list(source.rglob('*')))} files, "
            f"{sum(p.stat().st_size for p in source.rglob('*') if p.is_file()) / 2**20:.1f} MiB\n"
        )

        python_results = run_tool(
            "python-cli", [sys.executable, "-m", "pictowebp"], source, args.runs
        )
        rust_results = run_tool("rust-cli", [str(rust_binary())], source, args.runs)

    aggregates = {
        "python-cli": aggregate("python-cli", python_results),
        "rust-cli": aggregate("rust-cli", rust_results),
    }
    perf.write_bench(aggregates)

    print("\nSummary (best of runs):")
    print(f"  {'tool':<12} {'best s':>7} {'img/s':>8} {'MiB/s':>7} {'reduce %':>9}")
    for label, agg in aggregates.items():
        print(
            f"  {label:<12} {agg['best_wall_seconds']:>7.2f} "
            f"{agg['best_images_per_second']:>8.2f} {agg['best_mib_per_second']:>7.2f} "
            f"{agg['mean_reduction_pct']:>8.1f}%"
        )
    print(f"\nWrote comparison to {perf.REPORT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

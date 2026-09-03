"""Benchmark the Python and Rust CLIs against the realistic photo set.

Run:

    uv run python tests/e2e/run_realistic_bench.py --runs 3

Pipeline: ensures the 10,000-photo dataset (auto-downloads, rate-limited, never
deletes it), runs each CLI on a *copy* in a temp dir, captures wall-clock time,
throughput and compression ratio, cleans the copy up, then writes the
comparison into ``tests/e2e/perf-results.json`` (``bench`` section) and prints
a readable table.

Options extend the same pipeline to every corpus and thread count used in the
published benchmarks:

    --corpus photos|phone|camera   which dataset (camera/phone are personal
                                   gitignored folders; skipped when missing)
    --threads N                    worker threads (default 2; the published
                                   scale numbers use 8 and 16)
    --max-files N                  cap the copy to the first N files for a
                                   quick run (keys include the cap)
    --ladder N                     additionally run a quality ladder
                                   (q60/75/80/90 + lossless) on an N-file subset

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

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


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
CORPORA = {
    "photos": E2E_DIR / "real_images",
    "phone": E2E_DIR / "real_screenshots",
    "camera": E2E_DIR / "camera_images",
}
DOWNLOAD_SCRIPT = E2E_DIR / "download_real_dataset.py"
RUST_CRATE = ROOT / "src_rust"
RUST_EXE = "pictowebp.exe" if sys.platform == "win32" else "pictowebp"


def ensure_dataset(count: int = 500) -> bool:
    if sum(1 for p in CORPORA["photos"].rglob("*") if p.is_file()) >= count:
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


def copy_capped(source: Path, work: Path, max_files: int | None) -> int:
    """Clone ``source`` into ``work``, optionally capped to the first N files
    (sorted, structure preserved). Returns the number of files copied."""
    files = sorted(p for p in source.rglob("*") if p.is_file())
    if max_files is not None:
        files = files[:max_files]
    for path in files:
        target = work / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    return len(files)


def run_tool(
    label: str,
    command: list[str],
    source: Path,
    runs: int,
    threads: int,
    max_files: int | None,
) -> list[dict]:
    results = []
    for run in range(runs):
        work = Path(tempfile.mkdtemp(prefix=f"pw-bench-{label}-")) / "source"
        copied = copy_capped(source, work, max_files)
        try:
            started = perf_counter()
            proc = subprocess.run(
                [*command, str(work), "-q", "80", "-t", str(threads), "--no-progress"],
                capture_output=True,
                text=True,
                timeout=3600,
                # Keep any log file (e.g. pictowebp.log) inside the disposable
                # temp dir so it is cleaned up with the corpus, not the repo.
                cwd=work.parent,
            )
            elapsed = perf_counter() - started
            if proc.returncode != 0:
                raise RuntimeError(f"{label} run {run + 1} failed:\n{proc.stdout}\n{proc.stderr}")
            metrics = perf.measure(work, output_folder(work), elapsed, proc.stdout)
            metrics["threads"] = threads
            if max_files is not None:
                metrics["max_files"] = max_files
                metrics["images"] = copied
            results.append(metrics)
            print(f"  {label} run {run + 1}: {perf.format_line(label, metrics)}")
        finally:
            shutil.rmtree(work.parent, ignore_errors=True)
    return results


def aggregate(label: str, results: list[dict]) -> dict:
    return {
        "tool": label,
        "images": results[0]["images"],
        "threads": results[0].get("threads", 2),
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


def run_ladder(source: Path, subset: int, threads: int) -> dict:
    """Quality ladder on an N-file subset: q60/75/80/90 + lossless, Python CLI."""
    legs: dict[str, dict] = {}
    for setting in ("60", "75", "80", "90", "lossless"):
        work = Path(tempfile.mkdtemp(prefix=f"pw-ladder-{setting}-")) / "source"
        copied = copy_capped(source, work, subset)
        try:
            started = perf_counter()
            quality_args = ["--lossless"] if setting == "lossless" else ["-q", setting]
            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pictowebp",
                    str(work),
                    *quality_args,
                    "-t",
                    str(threads),
                    "--no-progress",
                ],
                capture_output=True,
                text=True,
                timeout=3600,
                cwd=work.parent,
            )
            elapsed = perf_counter() - started
            if proc.returncode != 0:
                raise RuntimeError(f"ladder q{setting} failed:\n{proc.stdout}\n{proc.stderr}")
            metrics = perf.measure(work, output_folder(work), elapsed, proc.stdout)
            legs[f"q{setting}" if setting != "lossless" else "lossless"] = {
                "images": copied,
                "output_mib": metrics["output_mib"],
                "reduction_pct": metrics["reduction_pct"],
                "wall_seconds": metrics["wall_seconds"],
            }
            print(
                f"  ladder {setting}: {metrics['reduction_pct']}% smaller "
                f"({metrics['output_mib']} MiB, {metrics['wall_seconds']}s)"
            )
        finally:
            shutil.rmtree(work.parent, ignore_errors=True)
    return {"subset_files": subset, "threads": threads, "legs": legs}


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(__doc__ or "PicToWebP CLI benchmark").splitlines()[0]
    )
    parser.add_argument("--runs", type=int, default=3, help="runs per tool (default: 3)")
    parser.add_argument(
        "--corpus",
        choices=sorted(CORPORA),
        default="photos",
        help="which dataset to benchmark (default: photos)",
    )
    parser.add_argument(
        "--threads", type=int, default=2, help="worker threads per run (default: 2)"
    )
    parser.add_argument(
        "--max-files",
        type=int,
        default=None,
        help="cap the copy to the first N files (quick runs; included in the key)",
    )
    parser.add_argument(
        "--ladder",
        type=int,
        default=None,
        metavar="N",
        help="also run a quality ladder (q60/75/80/90 + lossless) on an N-file subset",
    )
    args = parser.parse_args()

    corpus = CORPORA[args.corpus]
    if not corpus.is_dir():
        print(f"Corpus folder {corpus} does not exist; nothing to benchmark.")
        return 0
    if args.corpus == "photos":
        print("Ensuring the realistic dataset (500+ photos)...")
        ensure_dataset()

    with tempfile.TemporaryDirectory(prefix="pw-bench-corpus-") as tmp:
        source = Path(tmp) / "source"
        if args.max_files is not None:
            source.mkdir(parents=True)
            copied = copy_capped(corpus, source, args.max_files)
            total = copied
        else:
            shutil.copytree(corpus, source)
            total = sum(1 for p in source.rglob("*") if p.is_file())
        size = sum(p.stat().st_size for p in source.rglob("*") if p.is_file()) / 2**20
        print(
            f"Corpus: {args.corpus} - {total} files, {size:.1f} MiB "
            f"(-q 80, -t {args.threads}, {args.runs} run(s))\n"
        )

        python_results = run_tool(
            "python-cli",
            [sys.executable, "-m", "pictowebp"],
            source,
            args.runs,
            args.threads,
            args.max_files,
        )
        rust_results = run_tool(
            "rust-cli",
            [str(rust_binary())],
            source,
            args.runs,
            args.threads,
            args.max_files,
        )

        if args.ladder is not None:
            print(f"Quality ladder on {args.ladder}-file subset:")
            ladder = run_ladder(source, args.ladder, args.threads)
            perf.write_ladder(args.corpus, ladder)

    suffix = "" if args.threads == 2 and args.max_files is None else f"-t{args.threads}"
    if args.max_files is not None:
        suffix += f"-{args.max_files}f"
    aggregates = {
        f"python-cli{suffix}": aggregate(f"python-cli{suffix}", python_results),
        f"rust-cli{suffix}": aggregate(f"rust-cli{suffix}", rust_results),
    }
    perf.write_bench_merge(aggregates)

    print("\nSummary (best of runs):")
    print(f"  {'tool':<16} {'best s':>8} {'img/s':>8} {'MiB/s':>7} {'reduce %':>9}")
    for label, agg in aggregates.items():
        print(
            f"  {label:<16} {agg['best_wall_seconds']:>8.2f} "
            f"{agg['best_images_per_second']:>8.2f} {agg['best_mib_per_second']:>7.2f} "
            f"{agg['mean_reduction_pct']:>8.1f}%"
        )
    print(f"\nWrote comparison to {perf.REPORT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

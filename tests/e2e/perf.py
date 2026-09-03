"""Performance-metric capture for the realistic-data E2E runs.

Both CLIs report conversion stats on stdout (``Images converted``,
``Time taken``, ``Memory reduced``); these helpers also measure wall-clock time
and compute input/output byte sizes directly from the file system, then record
everything into ``tests/e2e/perf-results.json`` (gitignored).

The JSON shape is:

    {
      "e2e":  { "<tool>": [ {metrics...}, ... ] },   # appended per test run
      "bench": { "<tool>": { best/median aggregates } }  # written by run_realistic_bench.py
    }
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

REPORT = Path(__file__).resolve().parent / "perf-results.json"


def _load() -> dict:
    if REPORT.is_file():
        try:
            return json.loads(REPORT.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def tool_stats(stdout: str) -> dict:
    """Extract the stats the CLI prints about its own run."""
    converted = total = None
    match = re.search(r"Images converted:\s*(\d+)\s*/\s*(\d+)", stdout)
    if match:
        converted, total = int(match.group(1)), int(match.group(2))

    time_match = re.search(r"Time taken:\s*([\d.]+)\s*s", stdout)
    tool_seconds = float(time_match.group(1)) if time_match else None

    memory_match = re.search(r"Memory reduced:\s*([\d.]+)\s*MB\s*\(([\d.]+)%\)", stdout)
    saved_mib = float(memory_match.group(1)) if memory_match else None
    reduction_pct = float(memory_match.group(2)) if memory_match else None

    return {
        "tool_converted": converted,
        "tool_total": total,
        "tool_seconds": tool_seconds,
        "tool_saved_mib": saved_mib,
        "tool_reduction_pct": reduction_pct,
    }


def measure(source: Path, output: Path, wall_seconds: float, stdout: str = "") -> dict:
    """Compute the metrics relevant to a bulk image→WebP converter."""
    source_bytes = sum(p.stat().st_size for p in source.rglob("*") if p.is_file())
    webp_files = sorted(output.rglob("*.webp"))
    output_bytes = sum(p.stat().st_size for p in webp_files)
    images = len(webp_files)

    reduction = (1 - output_bytes / source_bytes) * 100 if source_bytes else 0.0
    elapsed = max(wall_seconds, 1e-6)
    return {
        "images": images,
        "source_mib": round(source_bytes / 2**20, 2),
        "output_mib": round(output_bytes / 2**20, 2),
        "reduction_pct": round(reduction, 1),
        "wall_seconds": round(wall_seconds, 2),
        "images_per_second": round(images / elapsed, 2),
        "mib_per_second": round((source_bytes / 2**20) / elapsed, 2),
        **tool_stats(stdout),
    }


def record(tool: str, metrics: dict) -> None:
    """Append one e2e run to the report under ``e2e/<tool>``."""
    report = _load()
    report.setdefault("e2e", {}).setdefault(tool, []).append(
        {"timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"), **metrics}
    )
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")


def write_bench(aggregates: dict) -> None:
    """Store the benchmark comparison under ``bench`` (see run_realistic_bench.py)."""
    report = _load()
    report["bench"] = aggregates
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")


def write_bench_merge(aggregates: dict) -> None:
    """Merge benchmark aggregates under ``bench`` without clobbering other keys."""
    report = _load()
    report.setdefault("bench", {}).update(aggregates)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")


def write_ladder(corpus: str, ladder: dict) -> None:
    """Store a quality-ladder result under ``ladder/<corpus>`` (see run_realistic_bench.py)."""
    report = _load()
    report.setdefault("ladder", {})[corpus] = ladder
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")


def format_line(tool: str, metrics: dict) -> str:
    """One readable table row for console output."""
    return (
        f"{tool:<12} {metrics['images']:>5} img | "
        f"{metrics['wall_seconds']:>7.2f}s | {metrics['images_per_second']:>6.2f} img/s | "
        f"{metrics['mib_per_second']:>7.2f} MiB/s | {metrics['reduction_pct']:>5.1f}% smaller"
    )

"""Terminal output helpers for the CLI (mirrors the Rust ``ui`` module)."""

from __future__ import annotations

import argparse
import contextlib
import sys
from collections import OrderedDict
from pathlib import Path

from pictowebp.constants import ERROR_REPORT_NAME
from pictowebp.progress import ConversionProgress
from pictowebp.style import (
    BOLD_CYAN,
    CYAN,
    DIM,
    GREEN,
    LINE,
    RED,
    YELLOW,
    paint,
    truncate_reason,
)
from pictowebp.utils import categorize_conversion_error, open_folder


def section(title: object, style: str = BOLD_CYAN) -> None:
    """Print a section header framed by separator lines."""
    print(f"  {paint(LINE, DIM)}")
    print(f"   {paint(title, style)}")
    print(f"  {paint(LINE, DIM)}")


def field(label: str, value: object, *, style: str = CYAN) -> None:
    """Print an aligned ``Label: value`` pair."""
    print(f"  {paint(label, style)} {value}")


def print_banner() -> None:
    """Print the welcome banner."""
    print()
    print(f"  {paint('PicToWebP', BOLD_CYAN)}")
    print(f"  {paint('Bulk Image to WebP Converter', DIM)}")
    print()


def print_no_files_found(source: Path) -> None:
    """Print the 'no files found' message."""
    print()
    section("No convertible images found", YELLOW)
    print()
    field("Source:", source)


def print_settings(
    source: Path,
    output: Path,
    quality: int,
    threads: int,
    *,
    lossless: bool,
    strip_metadata: bool,
    resize_width: int | None,
    resize_height: int | None,
) -> None:
    """Print the settings banner before conversion starts."""
    print()
    section("Configuration", BOLD_CYAN)
    print()
    field("Source:", source)
    field("Output:", output)
    field("Quality:", f"{quality}{' (lossless)' if lossless else ''}")
    field("Threads:", threads)
    field("Mode:", "lossless" if lossless else f"lossy q={quality}")
    field("Metadata:", "strip" if strip_metadata else "keep")
    if resize_width or resize_height:
        size = f"{resize_width or 'auto'}x{resize_height or 'auto'}"
        field("Resize:", f"max {size}")
    else:
        field("Resize:", "original")
    print()


def _summarize_failures(details: list[tuple[str, str]]) -> None:
    """Render the grouped failure list, with the count of distinct reasons."""
    if not details:
        return

    print()
    section(f"Files Not Converted ({len(details)})", RED)
    print()

    groups: OrderedDict[str, list[str]] = OrderedDict()
    for file_path, reason in details:
        groups.setdefault(reason, []).append(file_path)

    sorted_groups = sorted(groups.items(), key=lambda item: len(item[1]), reverse=True)

    for reason, paths in sorted_groups:
        category = categorize_conversion_error(reason)
        display_reason = truncate_reason(reason)
        if len(paths) == 1:
            print(f"  {paint(category + ':', YELLOW)} {display_reason}")
            print(f"    {paint(paths[0], DIM)}")
        else:
            print(f"  {paint(category + ':', YELLOW)} {display_reason} ({len(paths)})")
            for path in paths:
                print(f"    {paint(path, DIM)}")
        print()


def format_duration(seconds: float) -> str:
    """Format an elapsed duration for humans (e.g. ``46.1s``, ``3m 05s``)."""
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, secs = divmod(int(seconds), 60)
    return f"{minutes}m {secs:02d}s"


def _maybe_open_output_folder(output_path: Path, converted: int) -> None:
    """Ask whether to open the output folder; interactive terminals only."""
    if converted == 0 or not (sys.stdin.isatty() and sys.stdout.isatty()):
        return
    try:
        answer = input("  Open the output folder? [Y/n] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return
    if answer in ("", "y", "yes"):
        with contextlib.suppress(OSError):
            open_folder(output_path)


def render_final_summary(
    progress: ConversionProgress,
    args: argparse.Namespace,
    source_folder: Path,
) -> int:
    """Print the run summary and return the process exit code."""
    snap = progress.snapshot()
    if snap["total_files"] == 0:
        print_no_files_found(source_folder)
        return 0

    output_folder = snap["output_folder"]
    output_path = Path(output_folder) if output_folder else None
    failed = snap["failed_files"]
    total = snap["total_files"]
    converted = snap["converted_files"]

    if failed == 0:
        section("✓ Conversion Complete", GREEN)
    else:
        section("Conversion Complete (with errors)", YELLOW)
    print()
    if output_path:
        field("Output folder:", output_path)
    field("Images converted:", f"{converted:,}/{total:,}")
    saved_mib = snap["bytes_saved"] / (1024 * 1024)
    field(
        "Memory reduced:",
        f"{saved_mib:.2f} MB ({snap['reduction_percent']:.2f}%)",
    )
    field("Time taken:", format_duration(snap["elapsed_seconds"]))

    details = progress.failure_details()
    _summarize_failures(details)

    if details:
        report = args.report or (output_path / ERROR_REPORT_NAME if output_path else None)
        if report and report.exists():
            field("Error report:", report)
        elif report:
            print(f"  {paint('Warning:', YELLOW)} Could not write {report}")

    print(f"  {paint(LINE, DIM)}")
    print()
    if output_path:
        _maybe_open_output_folder(output_path, converted)
    # Exit non-zero only when nothing converted (a hard failure). Partial
    # failures are reported in the summary and the error report, but do
    # not warrant a non-zero exit code.
    if failed and converted == 0:
        return 3
    return 0

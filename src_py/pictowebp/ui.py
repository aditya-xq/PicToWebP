"""Terminal output helpers for the CLI (mirrors the Rust ``ui`` module)."""

from __future__ import annotations

import contextlib
from collections import OrderedDict
from pathlib import Path

from pictowebp.output import emit, is_json_mode
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
    sanitize,
    truncate_reason,
)
from pictowebp.utils import categorize_conversion_error, open_folder


def section(title: object, style: str = BOLD_CYAN) -> None:
    """Print a section header framed by separator lines."""
    emit(f"  {paint(LINE, DIM)}")
    emit(f"   {paint(title, style)}")
    emit(f"  {paint(LINE, DIM)}")


def field(label: str, value: object, *, style: str = CYAN) -> None:
    """Print an aligned ``Label: value`` pair."""
    emit(f"  {paint(label, style)} {sanitize(value)}")


def print_banner() -> None:
    """Print the welcome banner."""
    emit()
    emit(f"  {paint('PicToWebP', BOLD_CYAN)}")
    emit(f"  {paint('Bulk Image to WebP Converter', DIM)}")
    emit()


def print_no_files_found(source: Path) -> None:
    """Print the 'no files found' message."""
    emit()
    section("No convertible images found", YELLOW)
    emit()
    field("Source:", source)


def print_settings(
    source: Path,
    output: Path | None,
    quality: int,
    threads: int,
    *,
    lossless: bool,
    strip_metadata: bool,
    dry_run: bool = False,
    max_pixels: int = 500_000_000,
) -> None:
    """Print the settings banner before conversion starts."""
    emit()
    section("Configuration", BOLD_CYAN)
    emit()
    field("Source:", source)
    if output is None:
        label = "would be created next to the source" if dry_run else "created next to the source"
    elif str(output) in ("", "."):
        label = "current folder"
    else:
        label = output
    field("Output:", label)
    field("Quality:", f"{quality}{' (lossless)' if lossless else ''}")
    field("Threads:", threads)
    field("Max pixels:", f"{max_pixels:,}")
    field("Mode:", "lossless" if lossless else f"lossy q={quality}")
    field("Metadata:", "strip" if strip_metadata else "keep")
    emit()


def _summarize_failures(details: list[tuple[str, str]]) -> None:
    """Render the grouped failure list, with the count of distinct reasons."""
    if not details:
        return

    emit()
    section(f"Files Not Converted ({len(details)})", RED)
    emit()

    groups: OrderedDict[str, list[str]] = OrderedDict()
    for file_path, reason in details:
        groups.setdefault(reason, []).append(file_path)

    sorted_groups = sorted(groups.items(), key=lambda item: len(item[1]), reverse=True)

    for reason, paths in sorted_groups:
        category = categorize_conversion_error(reason)
        display_reason = truncate_reason(reason)
        if len(paths) == 1:
            emit(f"  {paint(category + ':', YELLOW)} {display_reason}")
            emit(f"    {paint(paths[0], DIM)}")
        else:
            emit(f"  {paint(category + ':', YELLOW)} {display_reason} ({len(paths)})")
            for path in paths:
                emit(f"    {paint(path, DIM)}")
        emit()


def format_duration(seconds: float) -> str:
    """Format an elapsed duration for humans (e.g. ``46.1s``, ``3m 05s``)."""
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, secs = divmod(int(seconds), 60)
    return f"{minutes}m {secs:02d}s"


def _maybe_open_output_folder(
    output_path: Path, converted: int, *, allow_prompt: bool = True
) -> None:
    """Ask whether to open the output folder; interactive terminals only."""
    import sys

    if (
        not allow_prompt
        or is_json_mode()
        or converted == 0
        or not (sys.stdin.isatty() and sys.stdout.isatty())
    ):
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
    source_folder: Path,
    *,
    report: Path | None = None,
    dry_run: bool = False,
    discovered: int | None = None,
    allow_prompt: bool = True,
) -> None:
    """Print the run summary (the caller decides the exit code)."""
    snap = progress.snapshot()
    failed = snap["failed_files"]
    collisions = snap["collision_files"]
    converted = snap["converted_files"]
    total = snap["total_files"]

    if dry_run:
        emit()
        section("Dry run (nothing written)", YELLOW)
        emit()
        field("Images found:", f"{discovered if discovered is not None else total:,}")
        field("Would convert:", f"{converted:,}")
        field("Would skip:", f"{failed + collisions:,}")
        field("Time taken:", format_duration(snap["elapsed_seconds"]))
        _summarize_failures(progress.failure_details())
        emit(f"  {paint(LINE, DIM)}")
        emit()
        return

    if total == 0:
        print_no_files_found(source_folder)
        return

    output_folder = snap["output_folder"]
    output_path = Path(output_folder) if output_folder else None

    if failed == 0 and collisions == 0:
        section("✓ Conversion Complete", GREEN)
    else:
        section("Conversion Complete (with errors)", YELLOW)
    emit()
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

    if details and report is not None:
        if report.exists():
            field("Error report:", report)
        else:
            emit(f"  {paint('Warning:', YELLOW)} Could not write {report}")

    emit(f"  {paint(LINE, DIM)}")
    emit()
    if output_path:
        _maybe_open_output_folder(output_path, converted, allow_prompt=allow_prompt)

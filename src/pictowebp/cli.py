"""Interactive command-line entry point for PicToWebP."""

from __future__ import annotations

import argparse
import contextlib
import logging
import os
import subprocess
import sys
from collections import OrderedDict
from collections.abc import Sequence
from pathlib import Path

from pictowebp import __version__
from pictowebp.console import force_utf8_stdio
from pictowebp.constants import (
    DEFAULT_QUALITY,
    DEFAULT_THREADS,
    ERROR_REPORT_NAME,
    MAX_QUALITY,
    MAX_RESIZE_HEIGHT,
    MAX_RESIZE_WIDTH,
    MAX_THREADS,
    MIN_QUALITY,
    MIN_RESIZE_HEIGHT,
    MIN_RESIZE_WIDTH,
    MIN_THREADS,
)
from pictowebp.converter import convert_folder
from pictowebp.logging_setup import DEFAULT_LOG_FILE, setup_logging
from pictowebp.style import (
    BOLD_CYAN,
    DIM,
    GREEN,
    LINE,
    RED,
    YELLOW,
    field,
    paint,
    section,
    truncate_reason,
)
from pictowebp.utils import categorize_conversion_error

logger = logging.getLogger(__name__)

_STRIP_METADATA_DEFAULT = True


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


def prompt_for_directory(prompt: str = "Enter the path to the source folder: ") -> Path:
    """Prompt until the user enters an existing directory."""
    while True:
        raw = input(prompt).strip().strip('"')
        if not raw:
            print("Please enter a path.")
            continue
        candidate = Path(raw).expanduser()
        if candidate.is_dir():
            return candidate.resolve()
        print("Invalid directory path. Please enter a valid path.")


def prompt_for_int(
    prompt: str,
    *,
    default: int,
    low: int,
    high: int,
) -> int:
    """Prompt for an integer within ``[low, high]``; empty input uses ``default``."""
    suffix = f" (default {default}): "
    while True:
        raw = input(f"{prompt}{suffix}").strip()
        if not raw:
            return default
        try:
            value = int(raw)
        except ValueError:
            print("Invalid input. Please enter a valid number.")
            continue
        if low <= value <= high:
            return value
        print(f"Value must be between {low} and {high}.")


def _int_in_range(
    raw: str,
    *,
    label: str,
    low: int,
    high: int,
) -> int:
    try:
        value = int(raw)
    except ValueError as exc:
        msg = f"'{raw}' is not a number"
        raise argparse.ArgumentTypeError(msg) from exc
    if not low <= value <= high:
        msg = f"{label} must be between {low} and {high}"
        raise argparse.ArgumentTypeError(msg)
    return value


def _quality_arg(raw: str) -> int:
    return _int_in_range(raw, label="quality", low=MIN_QUALITY, high=MAX_QUALITY)


def _threads_arg(raw: str) -> int:
    return _int_in_range(raw, label="threads", low=MIN_THREADS, high=MAX_THREADS)


def _make_resize_arg(label: str, low: int, high: int):
    def parse(raw: str) -> int:
        return _int_in_range(raw, label=label, low=low, high=high)

    return parse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pictowebp",
        description=(
            "Bulk-convert images to WebP. Run without arguments for an interactive session."
        ),
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )
    parser.add_argument(
        "path",
        nargs="?",
        type=Path,
        help="folder containing the images to convert",
    )
    parser.add_argument(
        "-q",
        "--quality",
        type=_quality_arg,
        help=f"WebP quality, {MIN_QUALITY}-{MAX_QUALITY} (default: {DEFAULT_QUALITY})",
    )
    parser.add_argument(
        "-t",
        "--threads",
        type=_threads_arg,
        help=f"number of worker threads (default: {DEFAULT_THREADS})",
    )
    parser.add_argument(
        "--lossless",
        action="store_true",
        help="use lossless WebP encoding (overrides --quality)",
    )
    parser.add_argument(
        "--keep-metadata",
        action="store_true",
        help=f"keep EXIF/metadata (default: {'strip' if _STRIP_METADATA_DEFAULT else 'keep'})",
    )
    parser.add_argument(
        "--resize-width",
        type=_make_resize_arg("width", MIN_RESIZE_WIDTH, MAX_RESIZE_WIDTH),
        help=f"max width in pixels, {MIN_RESIZE_WIDTH}-{MAX_RESIZE_WIDTH}",
    )
    parser.add_argument(
        "--resize-height",
        type=_make_resize_arg("height", MIN_RESIZE_HEIGHT, MAX_RESIZE_HEIGHT),
        help=f"max height in pixels, {MIN_RESIZE_HEIGHT}-{MAX_RESIZE_HEIGHT}",
    )
    parser.add_argument(
        "--no-progress",
        action="store_true",
        help="do not render the tqdm progress bar",
    )
    parser.add_argument(
        "--no-log",
        action="store_true",
        help=f"do not write to {DEFAULT_LOG_FILE.name}",
    )
    parser.add_argument(
        "--report",
        type=Path,
        help="path to write the conversion-errors report (overrides default)",
    )
    return parser


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


def _format_duration(seconds: float) -> str:
    """Format an elapsed duration for humans (e.g. ``46.1s``, ``3m 05s``)."""
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, secs = divmod(int(seconds), 60)
    return f"{minutes}m {secs:02d}s"


def _open_folder(path: Path) -> None:
    """Open a folder in the OS file explorer (best-effort)."""
    with contextlib.suppress(OSError):
        if sys.platform == "win32":
            os.startfile(path)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])


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
        _open_folder(output_path)


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point; returns a process exit code.

    Exit codes:
        0 — at least one file was converted successfully (the run is
            considered a success even when some files were skipped, because
            the skipped files are reported in the summary and persisted in
            the conversion-errors report for follow-up).
        2 — the source folder does not exist or is not a directory.
        3 — every file failed to convert (a hard failure, no output was
            produced).
    """
    force_utf8_stdio()
    args = build_parser().parse_args(argv)
    setup_logging(disable_file_logging=args.no_log)
    print_banner()

    source_folder = (args.path or prompt_for_directory()).expanduser()
    if not source_folder.is_dir():
        print(
            f"  {paint('Error:', RED)} Source folder does not exist or is not a directory: "
            f"{source_folder}"
        )
        return 2

    # In lossless mode quality is ignored, so never prompt for it.
    if args.lossless:
        quality = args.quality if args.quality is not None else DEFAULT_QUALITY
    else:
        quality = (
            args.quality
            if args.quality is not None
            else prompt_for_int(
                "Enter the quality",
                default=DEFAULT_QUALITY,
                low=MIN_QUALITY,
                high=MAX_QUALITY,
            )
        )
    threads = (
        args.threads
        if args.threads is not None
        else prompt_for_int(
            "Enter the number of threads",
            default=DEFAULT_THREADS,
            low=1,
            high=MAX_THREADS,
        )
    )

    if not args.no_progress and not sys.stdout.isatty():
        # Piped output shouldn't carry a progress bar.
        args.no_progress = True

    try:
        progress = convert_folder(
            source_folder,
            quality=quality,
            threads=threads,
            show_progress_bar=not args.no_progress,
            lossless=args.lossless,
            strip_metadata=not args.keep_metadata,
            resize_width=args.resize_width,
            resize_height=args.resize_height,
            report_path=args.report,
            on_started=lambda output, effective_workers: print_settings(
                source_folder,
                output,
                quality,
                threads,
                lossless=args.lossless,
                strip_metadata=not args.keep_metadata,
                resize_width=args.resize_width,
                resize_height=args.resize_height,
            ),
        )
    except KeyboardInterrupt:
        # Second Ctrl+C: the first one requested a graceful stop; this one
        # terminates immediately, keeping whatever already finished.
        print(f"\n  {paint('Cancelled', YELLOW)} — keeping everything already converted.")
        return 130
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
    field("Time taken:", _format_duration(snap["elapsed_seconds"]))

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


if __name__ == "__main__":
    sys.exit(main())

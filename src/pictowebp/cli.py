"""Interactive command-line entry point for PicToWebP."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from pictowebp import __version__
from pictowebp.console import force_utf8_stdio
from pictowebp.constants import (
    DEFAULT_QUALITY,
    DEFAULT_THREADS,
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
from pictowebp.style import RED, YELLOW, paint
from pictowebp.ui import print_banner, print_settings, render_final_summary

_STRIP_METADATA_DEFAULT = True


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


def _resolve_quality(args: argparse.Namespace) -> int:
    """Return the quality to use, prompting only when the CLI omitted it."""
    if args.quality is not None:
        return args.quality
    if args.lossless:
        # In lossless mode quality is ignored, so never prompt for it.
        return DEFAULT_QUALITY
    return prompt_for_int(
        "Enter the quality",
        default=DEFAULT_QUALITY,
        low=MIN_QUALITY,
        high=MAX_QUALITY,
    )


def _resolve_threads(args: argparse.Namespace) -> int:
    """Return the worker count to use, prompting only when the CLI omitted it."""
    if args.threads is not None:
        return args.threads
    return prompt_for_int(
        "Enter the number of threads",
        default=DEFAULT_THREADS,
        low=1,
        high=MAX_THREADS,
    )


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

    quality = _resolve_quality(args)
    threads = _resolve_threads(args)

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
    return render_final_summary(progress, args, source_folder)


if __name__ == "__main__":
    sys.exit(main())

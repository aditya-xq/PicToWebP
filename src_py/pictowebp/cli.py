"""Command-line entry point for PicToWebP."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import NoReturn

from pictowebp import __version__
from pictowebp.console import force_utf8_stdio
from pictowebp.constants import (
    DEFAULT_QUALITY,
    DEFAULT_THREADS,
    ERROR_REPORT_NAME,
    MAX_QUALITY,
    MAX_THREADS,
    MIN_QUALITY,
    MIN_THREADS,
)
from pictowebp.converter import convert_folder, pixel_limit_from_env
from pictowebp.enums import OutputImageFormat
from pictowebp.logging_setup import DEFAULT_LOG_FILE, setup_logging
from pictowebp.output import set_json_mode
from pictowebp.paths import resolve_output_folder
from pictowebp.report import (
    build_info,
    build_result,
    emit_json,
    error_payload,
    failures_from_details,
    print_info_human,
    stream_is_interactive,
)
from pictowebp.style import RED, YELLOW, paint
from pictowebp.ui import print_banner, print_settings, render_final_summary

_STRIP_METADATA_DEFAULT = True

EXIT_INVALID_ARGUMENT = 2
EXIT_TOTAL_FAILURE = 3
EXIT_FAILURES = 4
EXIT_EMPTY = 5
EXIT_CANCELLED = 130


def prompt_for_directory(prompt: str = "Enter the path to the source folder: ") -> Path:
    """Prompt until the user enters an existing path."""
    while True:
        raw = input(prompt).strip().strip('"')
        if not raw:
            print("Please enter a path.")
            continue
        candidate = Path(raw).expanduser()
        if candidate.exists():
            return candidate.resolve()
        print("Invalid path. Please enter a valid folder or image path.")


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


def _positive_int(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as exc:
        msg = f"'{raw}' is not a number"
        raise argparse.ArgumentTypeError(msg) from exc
    if value <= 0:
        msg = "must be a positive number"
        raise argparse.ArgumentTypeError(msg)
    return value


class _JsonAwareParser(argparse.ArgumentParser):
    """ArgumentParser that mirrors parse errors as JSON when asked.

    ``json_errors`` is set by :func:`main` after scanning the raw arguments,
    because ``--json`` itself is only known once parsing succeeds.
    """

    json_errors = False

    def error(self, message: str) -> NoReturn:
        if self.json_errors:
            emit_json(error_payload(message))
        super().error(message)


def build_parser() -> argparse.ArgumentParser:
    parser = _JsonAwareParser(
        prog="pictowebp",
        description=(
            "Bulk-convert images to WebP. Run without arguments for an interactive session."
        ),
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__} (python)",
    )
    parser.add_argument(
        "path",
        nargs="?",
        type=Path,
        help="folder (or single image) to convert",
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
        "--max-pixels",
        type=_positive_int,
        help="maximum decoded pixels per image (default: 500000000)",
    )
    parser.add_argument(
        "--keep-metadata",
        action="store_true",
        help=f"keep EXIF/metadata (default: {'strip' if _STRIP_METADATA_DEFAULT else 'keep'})",
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
    parser.add_argument(
        "--allow-report-outside",
        action="store_true",
        help="allow --report to write outside the output folder",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="write one machine-readable JSON object to stdout",
    )
    parser.add_argument(
        "--info",
        action="store_true",
        help="print tool metadata and exit (no conversion)",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="never prompt; use defaults for omitted options",
    )
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="force the interactive prompt flow even when stdio is not a terminal",
    )
    parser.add_argument(
        "--out",
        type=Path,
        help="write output into this folder (created when missing, must be empty)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="discover and validate only; write nothing",
    )
    parser.add_argument(
        "--fail-on-error",
        action="store_true",
        help="exit non-zero when any file fails or collides",
    )
    parser.add_argument(
        "--fail-on-empty",
        action="store_true",
        help="exit non-zero when no convertible images are found",
    )
    return parser


def _resolve_quality(args: argparse.Namespace, *, interactive: bool) -> int:
    """Return the quality to use, prompting only for interactive runs."""
    if args.quality is not None:
        return args.quality
    if args.lossless:
        # In lossless mode quality is ignored, so never prompt for it.
        return DEFAULT_QUALITY
    if not interactive:
        return DEFAULT_QUALITY
    return prompt_for_int(
        "Enter the quality",
        default=DEFAULT_QUALITY,
        low=MIN_QUALITY,
        high=MAX_QUALITY,
    )


def _resolve_threads(args: argparse.Namespace, *, interactive: bool) -> int:
    """Return the worker count, prompting only for interactive runs."""
    if args.threads is not None:
        return args.threads
    if not interactive:
        return DEFAULT_THREADS
    return prompt_for_int(
        "Enter the number of threads",
        default=DEFAULT_THREADS,
        low=1,
        high=MAX_THREADS,
    )


def _fail(args: argparse.Namespace, message: str, code: int) -> int:
    """Report an argument/IO failure and return the exit code."""
    if args.json:
        emit_json(error_payload(message))
    print(f"{paint('Error:', RED)} {message}", file=sys.stderr)
    return code


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point; returns a process exit code.

    Exit codes:
        0 — at least one file was converted successfully (the run is
            considered a success even when some files were skipped, because
            the skipped files are reported in the summary and persisted in
            the conversion-errors report for follow-up).
        2 — invalid arguments, or the source/out path is not usable.
        3 — every file failed to convert (a hard failure, no output was
            produced).
        4 — ``--fail-on-error`` and at least one file failed or collided.
        5 — ``--fail-on-empty`` and no convertible images were found.
        130 — cancelled by the user.
    """
    force_utf8_stdio()
    argv_list = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    if isinstance(parser, _JsonAwareParser):
        # Argument errors should still be machine-readable when --json was
        # requested, even though parsing has not produced a namespace yet.
        parser.json_errors = "--json" in argv_list
    args = parser.parse_args(argv_list)
    set_json_mode(args.json)

    if args.info:
        if args.json:
            emit_json(build_info())
        else:
            print_info_human()
        return 0

    interactive = not args.yes and not args.json and (args.interactive or stream_is_interactive())
    # A JSON run must keep stdout clean and must not persist a log file.
    setup_logging(disable_file_logging=args.no_log or args.json)

    if not args.json:
        print_banner()

    source = args.path
    if source is None:
        if interactive:
            source = prompt_for_directory()
        else:
            return _fail(
                args,
                "No source path provided. Pass a folder or a single image path, "
                "or run without arguments in a terminal.",
                EXIT_INVALID_ARGUMENT,
            )

    source = source.expanduser()
    if not source.exists():
        return _fail(args, f"Source path does not exist: {source}", EXIT_INVALID_ARGUMENT)
    if not source.is_dir() and not source.is_file():
        return _fail(
            args,
            f"Source path is neither a folder nor a file: {source}",
            EXIT_INVALID_ARGUMENT,
        )

    single_file = source.is_file()
    source_root = source.parent if single_file else source

    quality = _resolve_quality(args, interactive=interactive)
    threads = _resolve_threads(args, interactive=interactive)
    max_pixels = args.max_pixels if args.max_pixels is not None else pixel_limit_from_env()

    no_progress = args.no_progress or args.json
    if not no_progress and not sys.stdout.isatty():
        # Piped output shouldn't carry a progress bar.
        no_progress = True

    try:
        if single_file:
            output_folder = resolve_output_folder(
                source_root,
                OutputImageFormat.WEBP,
                requested=args.out,
                single_file=True,
                dry_run=args.dry_run,
            )
        else:
            # Folder runs resolve (and create) their destination inside the
            # converter, after discovery, so an empty source never leaves a
            # stray directory behind.
            output_folder = None
    except (ValueError, OSError) as exc:
        return _fail(args, str(exc), EXIT_INVALID_ARGUMENT)

    print_settings(
        source,
        output_folder if single_file else args.out,
        quality,
        threads,
        lossless=args.lossless,
        strip_metadata=not args.keep_metadata,
        dry_run=args.dry_run,
        max_pixels=max_pixels,
    )

    files = [source] if single_file else None
    requested_out = None if single_file else args.out

    try:
        tracker = convert_folder(
            source_root,
            quality=quality,
            threads=threads,
            show_progress_bar=not no_progress,
            lossless=args.lossless,
            strip_metadata=not args.keep_metadata,
            report_path=args.report,
            files=files,
            output_folder=output_folder,
            requested_out=requested_out,
            allow_report_outside=args.allow_report_outside,
            max_pixels=max_pixels,
            single_file=single_file,
            dry_run=args.dry_run,
        )
    except KeyboardInterrupt:
        # Second Ctrl+C: the first one requested a graceful stop; this one
        # terminates immediately, keeping whatever already finished.
        print(f"\n  {paint('Cancelled', YELLOW)} — keeping everything already converted.")
        return EXIT_CANCELLED
    except (ValueError, OSError) as exc:
        # --out validation and folder allocation happen inside the converter
        # for folder runs; report them as argument errors, not crashes.
        return _fail(args, str(exc), EXIT_INVALID_ARGUMENT)
    except Exception as exc:  # top-level guard for agent/CI use
        if args.json:
            emit_json(error_payload(str(exc) or type(exc).__name__))
        print(f"{paint('Error:', RED)} {exc}", file=sys.stderr)
        return 1

    snap = tracker.snapshot()
    failed = snap["failed_files"]
    collisions = snap["collision_files"]
    converted = snap["converted_files"]
    cancelled = snap["status"] == "cancelled"
    skipped = failed + collisions
    output_path = Path(snap["output_folder"]) if snap["output_folder"] else None

    report: Path | None = None
    if skipped and not (single_file and args.report is None):
        if args.report is not None:
            report = args.report
        elif output_path is not None:
            report = output_path / ERROR_REPORT_NAME

    if args.json:
        payload = build_result(
            source=source,
            output_folder=output_path,
            dry_run=args.dry_run,
            cancelled=cancelled,
            settings=SimpleNamespace(
                quality=quality,
                lossless=args.lossless,
                threads=threads,
                max_pixels=max_pixels,
                strip_metadata=not args.keep_metadata,
            ),
            counts={
                "discovered": snap["total_files"],
                "converted": converted,
                "failed": failed,
                "collisions": collisions,
            },
            bytes_summary={
                "source": snap["original_bytes"],
                "output": snap["converted_bytes"],
                "saved": snap["bytes_saved"],
                "reduction_percent": snap["reduction_percent"],
            },
            duration_ms=int(snap["elapsed_seconds"] * 1000),
            failures=failures_from_details(tracker.failure_details()),
            report_path=report if report is not None and report.exists() else None,
        )
        emit_json(payload)
    else:
        render_final_summary(
            tracker,
            source,
            report=report if report is not None and report.exists() else None,
            dry_run=args.dry_run,
            allow_prompt=not args.yes,
        )

    if cancelled:
        return EXIT_CANCELLED
    if args.fail_on_error and skipped:
        return EXIT_FAILURES
    # A dry run is a plan, not a conversion: never report "nothing converted".
    if not args.dry_run and converted == 0 and skipped:
        return EXIT_TOTAL_FAILURE
    if args.fail_on_empty and snap["total_files"] == 0:
        return EXIT_EMPTY
    return 0


if __name__ == "__main__":
    sys.exit(main())

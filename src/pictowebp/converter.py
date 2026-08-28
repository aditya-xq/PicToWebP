"""Core multi-process conversion engine."""

from __future__ import annotations

import contextlib
import logging
import os
import signal
import threading
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor, as_completed
from contextlib import contextmanager
from pathlib import Path
from time import perf_counter

from tqdm import tqdm

from pictowebp.constants import (
    CHUNK_SIZE,
    DEFAULT_QUALITY,
    DEFAULT_THREADS,
    ERROR_REPORT_NAME,
)
from pictowebp.enums import OutputImageFormat
from pictowebp.progress import ConversionProgress
from pictowebp.style import DIM, GREEN, YELLOW, paint
from pictowebp.utils import (
    ConversionError,
    categorize_conversion_error,
    check_disk_space,
    discover_images,
    format_bytes,
    process_file,
    resolve_output_folder,
)

logger = logging.getLogger(__name__)

# Work is parallelised across worker processes, so each process must keep
# its native codec threads at 1 to avoid oversubscribing the CPU.
os.environ.setdefault("OMP_NUM_THREADS", "1")

# Tracks the currently running conversion so a SIGINT handler can request
# cooperative cancellation. Module-level state is acceptable because only
# one conversion can meaningfully run per process at a time.
_CURRENT_CANCELLATION: threading.Event | None = None


@contextmanager
def cancellation_scope() -> Callable[[], bool]:
    """Provide a callable that returns True if cancellation was requested.

    Used by :func:`convert_folder` to install a SIGINT handler that records
    a cancellation request and by tests to simulate a user pressing Ctrl+C.

    Signal handlers can only be installed from the main thread; in other
    contexts the context manager still works but only programmatic
    cancellation via :func:`request_cancellation` will be detected.
    """
    event = threading.Event()
    global _CURRENT_CANCELLATION
    _CURRENT_CANCELLATION = event

    main_thread = threading.current_thread() is threading.main_thread()
    previous: signal._HANDLER | None = None
    installed = False

    if main_thread:
        try:
            previous = signal.getsignal(signal.SIGINT)

            def handler(signum, frame):
                event.set()
                # Restore the previous handler so a second Ctrl+C terminates hard.
                signal.signal(signal.SIGINT, previous)

            signal.signal(signal.SIGINT, handler)
            installed = True
        except (ValueError, OSError):
            # Signal handlers cannot be installed (e.g. non-main thread).
            installed = False

    try:
        yield event.is_set
    finally:
        if installed:
            with contextlib.suppress(ValueError, OSError):
                signal.signal(signal.SIGINT, previous)
        _CURRENT_CANCELLATION = None


def request_cancellation() -> bool:
    """Programmatically request cancellation of the active conversion."""
    if _CURRENT_CANCELLATION is None:
        return False
    _CURRENT_CANCELLATION.set()
    return True


def convert_folder(
    source_folder: Path,
    *,
    quality: int = DEFAULT_QUALITY,
    threads: int | None = None,
    output_format: OutputImageFormat = OutputImageFormat.WEBP,
    progress: ConversionProgress | None = None,
    show_progress_bar: bool = True,
    lossless: bool = False,
    strip_metadata: bool = True,
    resize_width: int | None = None,
    resize_height: int | None = None,
    on_started: Callable[[Path, int], None] | None = None,
    report_path: Path | None = None,
) -> ConversionProgress:
    """Convert every supported image under ``source_folder`` to ``output_format``.

    Files are processed on a process pool for true CPU parallelism (no GIL).
    Work is submitted in chunks to limit memory overhead on large batches.

    :param source_folder: Folder containing the images to convert.
    :param quality: WebP quality in the range 1-100.
    :param threads: Worker count; defaults to CPU count.
    :param output_format: Target image format.
    :param progress: Optional externally-owned progress tracker.
    :param show_progress_bar: Render a tqdm bar (disable for headless use).
    :param lossless: Use lossless WebP encoding.
    :param strip_metadata: Remove EXIF/metadata from output images.
    :param resize_width: Optional max width to resize to (preserves aspect ratio).
    :param resize_height: Optional max height to resize to (preserves aspect ratio).
    :param on_started: Optional callback invoked with the output folder and
        effective worker count immediately before conversion begins.
    :param report_path: Optional path to write the failure report. When
        ``None`` the report is written to ``<output_folder>/conversion-errors.txt``.
    :return: The progress tracker holding final statistics.
    """
    tracker = progress if progress is not None else ConversionProgress()
    worker_count = max(1, threads or DEFAULT_THREADS)

    print(f"  {paint('Discovering images', DIM)}", flush=True)
    files = discover_images(source_folder)
    total_bytes = 0
    for path in files:
        with contextlib.suppress(OSError):
            total_bytes += path.stat().st_size
    print(
        f"  {paint(f'Found {len(files):,} images ({format_bytes(total_bytes)})', DIM)}",
        flush=True,
    )

    if not files:
        logger.info("No convertible images found in %s", source_folder)
        return tracker

    output_folder = resolve_output_folder(source_folder, output_format)

    collision_errors = _output_collisions(files, source_folder, output_format)
    files = [path for path in files if path not in collision_errors]

    # Cap workers: ProcessPool has higher startup cost than threads, so
    # don't oversubscribe for tiny batches.
    effective_workers = min(worker_count, len(files))
    tracker.start(total_files=len(files) + len(collision_errors))
    tracker.set_output_folder(str(output_folder))

    # Pre-flight: warn when the destination is running low on free space.
    disk = check_disk_space(output_folder)
    if disk.free_bytes is not None:
        free_mib = disk.free_bytes / (1024 * 1024)
        if disk.low:
            print(
                f"  {paint('Warning', YELLOW)}: only {free_mib:.0f} MiB free in "
                f"{disk.path} — conversion may run out of space.",
                flush=True,
            )

    # Log the run parameters to the log file only. The terminal already shows
    # a structured "Configuration" block before this point, so repeating the
    # same information via ``logger.info`` would just be noise on stderr.
    logger.debug(
        "Converting %d images from %s to %s (quality=%d, threads=%d, lossless=%s, "
        "strip_metadata=%s, resize=%sx%s)",
        tracker.total_files,
        source_folder,
        output_folder,
        quality,
        worker_count,
        lossless,
        strip_metadata,
        resize_width or "auto",
        resize_height or "auto",
    )

    started = perf_counter()
    for path, reason in collision_errors.items():
        tracker.record_failure(file_path=str(path.resolve()), reason=reason)

    if not files:
        tracker.finish("completed", elapsed_seconds=perf_counter() - started)
        _write_failure_report(output_folder, tracker.failure_details(), report_path)
        return tracker

    print(f"  {paint('Converting', GREEN)} ({effective_workers} workers)", flush=True)

    with (
        cancellation_scope() as is_cancelled,
        ProcessPoolExecutor(max_workers=effective_workers) as executor,
        tqdm(
            total=tracker.total_files,
            unit="img",
            desc="Converting",
            disable=not show_progress_bar,
        ) as progress_bar,
    ):
        # Invoke the callback inside the cancellation scope so that
        # ``request_cancellation`` issued by the callback is observed by the loop.
        if on_started is not None:
            try:
                on_started(output_folder, effective_workers)
            except Exception:
                tracker.finish(
                    "failed",
                    elapsed_seconds=perf_counter() - started,
                    error="conversion startup callback failed",
                )
                raise
        # Submit work in chunks to avoid flooding the memory with futures
        # and to let completed results be processed incrementally.
        for chunk_start in range(0, len(files), CHUNK_SIZE):
            if is_cancelled():
                break
            chunk = files[chunk_start : chunk_start + CHUNK_SIZE]
            futures = {
                executor.submit(
                    process_file,
                    path,
                    source_folder,
                    output_folder,
                    quality,
                    output_format,
                    lossless=lossless,
                    strip_metadata=strip_metadata,
                    resize_width=resize_width,
                    resize_height=resize_height,
                ): path
                for path in chunk
            }
            for future in as_completed(futures):
                if is_cancelled():
                    future.cancel()
                    continue
                outcome = future.result()
                if isinstance(outcome, ConversionError):
                    tracker.record_failure(
                        file_path=str(outcome.file_path.resolve()),
                        reason=outcome.reason,
                    )
                else:
                    tracker.record(outcome.original_bytes, outcome.converted_bytes)
                # Live feedback: how much has been saved so far, plus the
                # number of skipped files, right on the progress bar.
                postfix = f"{format_bytes(tracker.bytes_saved)} saved"
                if tracker.failed_files:
                    postfix += f" · {tracker.failed_files} skipped"
                progress_bar.set_postfix_str(postfix)
                progress_bar.update(1)

    elapsed = perf_counter() - started
    if is_cancelled():
        tracker.finish("cancelled", elapsed_seconds=elapsed, error="cancelled by user")
    else:
        tracker.finish("completed", elapsed_seconds=elapsed)
    _write_failure_report(output_folder, tracker.failure_details(), report_path)
    return tracker


def _output_collisions(
    files: list[Path], source_folder: Path, output_format: OutputImageFormat
) -> dict[Path, str]:
    """Identify inputs that would overwrite the same output image."""
    destinations: dict[Path, list[Path]] = {}
    for path in files:
        destination = (path.relative_to(source_folder)).with_suffix(output_format.file_extension)
        destinations.setdefault(destination, []).append(path)

    collisions: dict[Path, str] = {}
    for destination, paths in destinations.items():
        if len(paths) > 1:
            reason = f"Multiple input files map to the same output: {destination}"
            collisions.update(dict.fromkeys(paths, reason))
    return collisions


def _write_failure_report(
    output_folder: Path,
    failures: list[tuple[str, str]],
    override: Path | None = None,
) -> None:
    """Persist all conversion failures so large batches remain reviewable."""
    if not failures:
        return

    report = override if override is not None else output_folder / ERROR_REPORT_NAME
    try:
        report.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.warning("Could not prepare error report folder %s: %s", report.parent, exc)
        return

    lines = ["PicToWebP conversion errors", ""]
    for file_path, reason in failures:
        lines.extend((f"[{categorize_conversion_error(reason)}] {reason}", file_path, ""))
    try:
        # Write to a sibling temp file in the same directory then rename to keep
        # the report itself atomic against interruption.
        temp = report.with_name(f".{report.name}.tmp")
        temp.write_text("\n".join(lines), encoding="utf-8")
        os.replace(temp, report)
    except OSError as exc:
        logger.warning("Could not write conversion error report %s: %s", report, exc)
    else:
        logger.info("Conversion error report written to %s", report)

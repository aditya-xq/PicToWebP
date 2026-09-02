"""Core multi-process conversion engine (batch + per-file)."""

from __future__ import annotations

import contextlib
import logging
import os
import signal
import tempfile
import threading
from collections.abc import Callable, Generator
from concurrent.futures import ProcessPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter

from PIL import Image
from tqdm import tqdm

from pictowebp.constants import (
    CHUNK_SIZE,
    DEFAULT_QUALITY,
    DEFAULT_THREADS,
    ERROR_REPORT_NAME,
)
from pictowebp.discovery import discover_images, sum_file_bytes
from pictowebp.enums import OutputImageFormat
from pictowebp.paths import resolve_output_folder
from pictowebp.progress import ConversionProgress
from pictowebp.style import DIM, GREEN, YELLOW, paint
from pictowebp.utils import (
    categorize_conversion_error,
    check_disk_space,
    format_bytes,
)

logger = logging.getLogger(__name__)

# Modes that may carry transparency are normalised to RGBA; everything else to RGB.
_ALPHA_MODES = frozenset({"RGBA", "LA", "PA", "P"})


@dataclass(frozen=True, slots=True)
class ProcessedFile:
    """Size bookkeeping for one converted image."""

    original_bytes: int
    converted_bytes: int


@dataclass(frozen=True, slots=True)
class ConversionError:
    """Details about a file that failed to convert."""

    file_path: Path
    reason: str


# Work is parallelised across worker processes, so each process must keep
# its native codec threads at 1 to avoid oversubscribing the CPU.
os.environ.setdefault("OMP_NUM_THREADS", "1")

# Tracks the currently running conversion so a SIGINT handler can request
# cooperative cancellation. Module-level state is acceptable because only
# one conversion can meaningfully run per process at a time.
_CURRENT_CANCELLATION: threading.Event | None = None


@contextmanager
def cancellation_scope() -> Generator[Callable[[], bool], None, None]:
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
    total_bytes = sum_file_bytes(files)
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
        "strip_metadata=%s)",
        tracker.total_files,
        source_folder,
        output_folder,
        quality,
        worker_count,
        lossless,
        strip_metadata,
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
                ): path
                for path in chunk
            }
            for future in as_completed(futures):
                if is_cancelled():
                    future.cancel()
                    continue
                _record_result(future.result(), tracker, progress_bar)

    elapsed = perf_counter() - started
    if is_cancelled():
        tracker.finish("cancelled", elapsed_seconds=elapsed, error="cancelled by user")
    else:
        tracker.finish("completed", elapsed_seconds=elapsed)
    _write_failure_report(output_folder, tracker.failure_details(), report_path)
    return tracker


def _record_result(
    outcome: ProcessedFile | ConversionError,
    tracker: ConversionProgress,
    progress_bar: tqdm,
) -> None:
    """Record one worker outcome and refresh the live progress postfix."""
    if isinstance(outcome, ConversionError):
        tracker.record_failure(
            file_path=str(outcome.file_path.resolve()),
            reason=outcome.reason,
        )
    else:
        tracker.record(outcome.original_bytes, outcome.converted_bytes)
    # Live feedback: how much has been saved so far, plus the number of
    # skipped files, right on the progress bar.
    postfix = f"{format_bytes(tracker.bytes_saved)} saved"
    if tracker.failed_files:
        postfix += f" · {tracker.failed_files} skipped"
    progress_bar.set_postfix_str(postfix)
    progress_bar.update(1)


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


def process_file(
    file_path: Path,
    source_folder: Path,
    output_folder: Path,
    quality: int,
    output_format: OutputImageFormat,
    *,
    lossless: bool = False,
    strip_metadata: bool = True,
) -> ProcessedFile | ConversionError:
    """Convert a single image into ``output_format``.

    The relative directory structure below ``source_folder`` is mirrored under
    ``output_folder``. Files that cannot be decoded are logged and skipped.

    :return: Size information on success, or a ``ConversionError`` when skipped.
    """
    relative_path = file_path.relative_to(source_folder)
    destination = (output_folder / relative_path).with_suffix(output_format.file_extension)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_destination: Path | None = None

    try:
        original_bytes = file_path.stat().st_size
        # The temp file lives next to the destination so the rename is a
        # single-filesystem call. We embed the destination stem plus a
        # PID/process-id suffix to make collisions effectively impossible when
        # multiple workers process same-stem images in parallel.
        temp_prefix = f".{destination.stem}.{os.getpid()}.{os.urandom(4).hex()}-"
        fd, temp_path_str = tempfile.mkstemp(
            prefix=temp_prefix, suffix=".tmp", dir=destination.parent
        )
        temporary_destination = Path(temp_path_str)
        # Close the descriptor immediately; Pillow reopens the file by path.
        os.close(fd)

        with Image.open(file_path) as img:
            prepared = prepare_image(img)
            save_kwargs = build_save_kwargs(
                img,
                output_format,
                quality=quality,
                lossless=lossless,
                strip_metadata=strip_metadata,
            )
            prepared.save(temporary_destination, **save_kwargs)
            os.replace(temporary_destination, destination)
    except Exception as exc:
        # Worker boundary: any per-file failure (corrupt data, unsupported
        # mode, Pillow's DecompressionBombError, ...) is reported as a skip
        # instead of aborting the whole batch. BaseException subclasses such
        # as KeyboardInterrupt still propagate.
        reason = str(exc) or type(exc).__name__
        # Log at INFO so the per-file skip is captured in the log file without
        # polluting the terminal. The CLI summary already shows every failed
        # file with its reason.
        logger.info("Skipping %s: %s", file_path, reason)
        if temporary_destination is not None:
            temporary_destination.unlink(missing_ok=True)
        return ConversionError(file_path=file_path, reason=reason)

    return ProcessedFile(original_bytes=original_bytes, converted_bytes=destination.stat().st_size)


def prepare_image(img: Image.Image) -> Image.Image:
    """Normalise the image mode for WebP encoding."""
    # Convert mode for format compatibility
    if img.mode == "RGB":
        result = img
    elif img.mode in _ALPHA_MODES:
        result = img.convert("RGBA")
    else:
        result = img.convert("RGB")

    return result


def build_save_kwargs(
    img: Image.Image,
    output_format: OutputImageFormat,
    *,
    quality: int,
    lossless: bool,
    strip_metadata: bool,
) -> dict:
    """Build Pillow ``save`` keyword arguments for a converted image.

    Pillow never copies metadata unless explicitly told to, so keeping it is
    an opt-in; stripping is the default for free.
    """
    save_kwargs: dict = {
        "format": output_format.pil_format,
        "quality": quality,
        "lossless": lossless,
    }
    if not strip_metadata:
        if exif := img.info.get("exif"):
            save_kwargs["exif"] = exif
        if icc := img.info.get("icc_profile"):
            save_kwargs["icc_profile"] = icc
    return save_kwargs

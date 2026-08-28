"""Filesystem helpers: image discovery, output folders and per-file conversion."""

from __future__ import annotations

import contextlib
import logging
import os
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from PIL import Image

from pictowebp.constants import LOW_DISK_WARNING_MIB
from pictowebp.enums import INPUT_SUFFIXES, OutputImageFormat

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


@dataclass(frozen=True, slots=True)
class DiskSpaceInfo:
    """Result of a free-space probe for a target folder."""

    path: Path
    free_bytes: int | None
    low: bool


_CORRUPT_TOKENS = ("cannot identify", "invalid", "parsing", "truncated", "end of file")
_UNREADABLE_TOKENS = ("no such file", "file not found", "not a directory")
_WRITE_TOKENS = ("write", "disk", "space")


def categorize_conversion_error(reason: str) -> str:
    """Return an actionable category for an image conversion failure."""
    normalized = reason.lower()
    if "permission denied" in normalized or "access is denied" in normalized:
        return "Permission denied"
    if any(token in normalized for token in _CORRUPT_TOKENS):
        return "Corrupt or mislabeled image"
    if any(token in normalized for token in _UNREADABLE_TOKENS):
        return "Unreadable file"
    if any(token in normalized for token in _WRITE_TOKENS):
        return "Output write failed"
    return "Conversion failed"


def check_disk_space(path: Path) -> DiskSpaceInfo:
    """Return free-space information for the volume holding ``path``.

    The result is best-effort: when the OS does not expose a free-space call
    (e.g. some non-filesystem URLs), ``free_bytes`` is ``None`` and ``low``
    is False.
    """
    try:
        target = path if path.exists() else path.parent
        usage = shutil.disk_usage(target)
        free = int(usage.free)
        return DiskSpaceInfo(
            path=target,
            free_bytes=free,
            low=free < LOW_DISK_WARNING_MIB * 1024 * 1024,
        )
    except (OSError, AttributeError):
        return DiskSpaceInfo(path=path, free_bytes=None, low=False)


_INPUT_SUFFIX_TUPLE = tuple(INPUT_SUFFIXES)


def discover_images(source_folder: Path) -> list[Path]:
    """Recursively find convertible images under ``source_folder``.

    Uses ``os.scandir`` for fast recursive traversal. Results are sorted for
    deterministic ordering.
    """
    results: list[Path] = []
    stack: list[Path] = [source_folder]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    if entry.is_dir(follow_symlinks=False):
                        if not entry.name.startswith("."):
                            stack.append(Path(entry.path))
                    elif entry.is_file(follow_symlinks=False) and entry.name.lower().endswith(
                        _INPUT_SUFFIX_TUPLE
                    ):
                        results.append(Path(entry.path))
        except PermissionError:
            continue
    results.sort()
    return results


def resolve_output_folder(source_folder: Path, output_format: OutputImageFormat) -> Path:
    """Create a unique output folder next to the source folder.

    The folder is named ``<source>_<format>_<timestamp>`` so repeated runs
    never clash.
    """
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    base_name = f"{source_folder.name}_{output_format.value.lower()}_{timestamp}"
    for suffix in range(10_000):
        name = base_name if suffix == 0 else f"{base_name}_{suffix}"
        output_folder = source_folder.parent / name
        try:
            output_folder.mkdir(parents=True)
        except FileExistsError:
            continue
        return output_folder
    raise OSError("Could not allocate a unique output folder")


def process_file(
    file_path: Path,
    source_folder: Path,
    output_folder: Path,
    quality: int,
    output_format: OutputImageFormat,
    *,
    lossless: bool = False,
    strip_metadata: bool = True,
    resize_width: int | None = None,
    resize_height: int | None = None,
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
            prepared = _prepare_image(img, resize_width=resize_width, resize_height=resize_height)
            save_kwargs: dict = {
                "format": output_format.pil_format,
                "quality": quality,
                "lossless": lossless,
            }
            if not strip_metadata:
                # Pillow never copies metadata unless explicitly told to, so
                # keeping it is an opt-in; stripping is the default for free.
                if exif := img.info.get("exif"):
                    save_kwargs["exif"] = exif
                if icc := img.info.get("icc_profile"):
                    save_kwargs["icc_profile"] = icc
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


def _prepare_image(
    img: Image.Image,
    *,
    resize_width: int | None = None,
    resize_height: int | None = None,
) -> Image.Image:
    """Normalise the image mode and optionally resize."""
    # Convert mode for format compatibility
    if img.mode == "RGB":
        result = img
    elif img.mode in _ALPHA_MODES:
        result = img.convert("RGBA")
    else:
        result = img.convert("RGB")

    # Resize if requested (preserve aspect ratio)
    if resize_width or resize_height:
        result = _resize_image(result, resize_width, resize_height)

    return result


def _resize_image(
    img: Image.Image,
    max_width: int | None,
    max_height: int | None,
) -> Image.Image:
    """Resize image to fit within max dimensions while preserving aspect ratio."""
    orig_w, orig_h = img.size
    new_w, new_h = orig_w, orig_h

    if max_width and orig_w > max_width:
        ratio = max_width / orig_w
        new_w = max_width
        new_h = int(orig_h * ratio)

    if max_height and new_h > max_height:
        ratio = max_height / new_h
        new_h = max_height
        new_w = int(new_w * ratio)

    if (new_w, new_h) != (orig_w, orig_h):
        return img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    return img


def get_folder_info(source_folder: Path) -> dict:
    """Get detailed info about a folder for the validate endpoint.

    Uses the same discovery rules as :func:`discover_images` (hidden
    directories skipped, same supported suffixes) so the preview matches
    what a conversion would actually process.
    """
    files = discover_images(source_folder)
    counts: dict[str, int] = {}
    total_size = 0
    for path in files:
        fmt = path.suffix.lower().lstrip(".")
        counts[fmt] = counts.get(fmt, 0) + 1
        with contextlib.suppress(OSError):
            total_size += path.stat().st_size

    return {
        "valid": len(files) > 0,
        "total_files": len(files),
        "format_counts": counts,
        "total_size_bytes": total_size,
        "total_size_display": format_bytes(total_size),
    }


def format_bytes(size_bytes: int) -> str:
    """Format bytes into a human-readable string."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"

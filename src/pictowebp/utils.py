"""Miscellaneous helpers: error categorization, disk probes, formatting, folder opening."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from pictowebp.constants import LOW_DISK_WARNING_MIB
from pictowebp.discovery import discover_images, sum_file_bytes


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


def open_folder(path: Path) -> None:
    """Open a folder in the OS file explorer (raises OSError on failure)."""
    if sys.platform == "win32":
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def get_folder_info(source_folder: Path) -> dict:
    """Get detailed info about a folder for the validate endpoint.

    Uses the same discovery rules as :func:`discover_images` (hidden
    directories skipped, same supported suffixes) so the preview matches
    what a conversion would actually process.
    """
    files = discover_images(source_folder)
    counts: dict[str, int] = {}
    for path in files:
        fmt = path.suffix.lower().lstrip(".")
        counts[fmt] = counts.get(fmt, 0) + 1
    total_size = sum_file_bytes(files)

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

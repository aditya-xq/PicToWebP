"""Recursive discovery of convertible images."""

from __future__ import annotations

import contextlib
import os
from pathlib import Path

from pictowebp.enums import INPUT_SUFFIXES

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


def sum_file_bytes(files: list[Path]) -> int:
    """Total size of ``files`` on disk, ignoring files that vanish mid-scan."""
    total = 0
    for path in files:
        with contextlib.suppress(OSError):
            total += path.stat().st_size
    return total

"""Console helpers."""

import contextlib
import sys


def force_utf8_stdio() -> None:
    """Make stdout/stderr UTF-8 so emoji survive Windows' legacy code pages."""
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            with contextlib.suppress(OSError, ValueError):  # exotic stream wrappers
                stream.reconfigure(encoding="utf-8")

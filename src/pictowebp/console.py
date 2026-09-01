"""Console helpers."""

import contextlib
import io
import sys
from typing import cast


def force_utf8_stdio() -> None:
    """Make stdout/stderr UTF-8 so emoji survive Windows' legacy code pages."""
    for stream in (sys.stdout, sys.stderr):
        if stream is not None:
            # Not every stream is a TextIOWrapper (e.g. test capture); the
            # AttributeError/ValueError guards keep those harmless.
            with contextlib.suppress(OSError, ValueError, AttributeError):
                cast(io.TextIOWrapper, stream).reconfigure(encoding="utf-8")

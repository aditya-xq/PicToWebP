"""Stream routing for the CLI.

Human output normally goes to stdout. In ``--json`` mode it is redirected to
stderr so stdout carries exactly one machine-readable object and nothing else.
"""

from __future__ import annotations

import sys
from typing import TextIO

_JSON_MODE = False


def set_json_mode(enabled: bool) -> None:
    """Route human output to stderr when ``enabled``."""
    global _JSON_MODE
    _JSON_MODE = enabled


def is_json_mode() -> bool:
    return _JSON_MODE


def active_stream() -> TextIO:
    """The stream human output should use right now."""
    return sys.stderr if _JSON_MODE else sys.stdout


def emit(message: object = "", *, end: str = "\n", flush: bool = True) -> None:
    """Print to the active human-output stream."""
    print(message, file=active_stream(), end=end, flush=flush)

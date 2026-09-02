"""ANSI styling helpers shared by CLI and progress reporting.

Importing from this module keeps colors, separators and section rendering
consistent across the application. Colors are emitted only when stdout is a
real terminal and the :envvar:`NO_COLOR` convention is not set.
"""

from __future__ import annotations

import os
import sys

from pictowebp.constants import MAX_REASON_DISPLAY_LENGTH

LINE = "────────────────────────────────────────────────────────────────"

RESET = "\033[0m"
BOLD_CYAN = "\033[1;36m"
CYAN = "\033[36m"
DIM = "\033[2m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"


def supports_color() -> bool:
    """Return True if ANSI colors should be emitted on stdout."""
    if os.environ.get("NO_COLOR"):
        return False
    return sys.stdout.isatty()


def paint(value: object, style: str) -> str:
    """Wrap ``value`` in ``style`` if the terminal supports color."""
    text = str(value)
    if supports_color():
        return f"{style}{text}{RESET}"
    return text


def truncate_reason(reason: str) -> str:
    """Trim a long error message to a readable terminal length."""
    if len(reason) <= MAX_REASON_DISPLAY_LENGTH:
        return reason
    return reason[: MAX_REASON_DISPLAY_LENGTH - 1] + "…"

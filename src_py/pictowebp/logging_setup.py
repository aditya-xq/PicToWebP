"""Application-wide logging configuration.

Call :func:`setup_logging` once at startup; it is idempotent and safe to call
again (existing root handlers are replaced).
"""

from __future__ import annotations

import contextlib
import logging
import os
import sys
from pathlib import Path

LOG_FORMAT = "%(asctime)s - %(levelname)s - %(name)s - %(message)s"


def default_log_file() -> Path:
    """Per-user log location, never the current working directory."""
    if os.name == "nt":
        base = Path(os.environ["LOCALAPPDATA"]) if "LOCALAPPDATA" in os.environ else Path.home()
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Logs"
    else:
        state = os.environ.get("XDG_STATE_HOME")
        base = Path(state) if state else Path.home() / ".local" / "state"
    return base / "pictowebp" / "pictowebp.log"


DEFAULT_LOG_FILE = default_log_file()


def setup_logging(
    level: int = logging.INFO,
    log_file: Path | None = DEFAULT_LOG_FILE,
    *,
    disable_file_logging: bool = False,
) -> None:
    """Configure the root logger to write to stderr and optionally a file.

    :param level: Root logger level.
    :param log_file: Optional log file path. ``None`` disables the file handler
        even if ``disable_file_logging`` is not set.
    :param disable_file_logging: When True, no file handler is attached
        regardless of ``log_file``.
    """
    handlers: list[logging.Handler] = []
    # The terminal only shows warnings and errors; informational chatter
    # (e.g. "report written to ...") goes to the log file so the pretty
    # CLI output is never polluted by raw log lines.
    stderr_handler = logging.StreamHandler()
    stderr_handler.setLevel(logging.WARNING)
    handlers.append(stderr_handler)
    if log_file is not None and not disable_file_logging:
        # If we cannot open the log file (read-only file system, etc.)
        # keep going with just the stderr handler.
        with contextlib.suppress(OSError):
            log_file.parent.mkdir(parents=True, exist_ok=True)
            file_handler = logging.FileHandler(log_file, encoding="utf-8")
            file_handler.setLevel(logging.INFO)
            handlers.append(file_handler)

    logging.basicConfig(
        level=level,
        format=LOG_FORMAT,
        handlers=handlers,
        force=True,
    )

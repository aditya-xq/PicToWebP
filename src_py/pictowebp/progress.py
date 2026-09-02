"""Thread-safe progress tracking and reporting for conversions."""

import threading
from typing import Any, Literal

ProgressStatus = Literal["idle", "running", "completed", "failed", "cancelled"]

TERMINAL_STATUSES: frozenset[str] = frozenset({"completed", "failed", "cancelled"})


class ConversionProgress:
    """Aggregated, thread-safe state for a single conversion run.

    A single instance is shared between the worker threads that convert files
    and the callers that observe progress (CLI, SSE stream, API endpoint).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._status: ProgressStatus = "idle"
        self._error: str | None = None
        self._total_files = 0
        self._processed_files = 0
        self._converted_files = 0
        self._failed_files = 0
        self._original_bytes = 0
        self._converted_bytes = 0
        self._elapsed_seconds = 0.0
        self._output_folder: str | None = None
        self._source_folder: str | None = None
        self._current_file: str | None = None
        self._failure_details: list[tuple[str, str]] = []

    # -- lifecycle -------------------------------------------------------------

    def start(self, total_files: int) -> None:
        """Reset all counters and mark the run as running."""
        with self._lock:
            self._status = "running"
            self._error = None
            self._total_files = total_files
            self._processed_files = 0
            self._converted_files = 0
            self._failed_files = 0
            self._original_bytes = 0
            self._converted_bytes = 0
            self._elapsed_seconds = 0.0
            self._current_file = None
            self._failure_details = []

    def record(self, original_bytes: int, converted_bytes: int) -> None:
        """Record one successfully converted file."""
        with self._lock:
            self._processed_files += 1
            self._converted_files += 1
            self._original_bytes += original_bytes
            self._converted_bytes += converted_bytes

    def record_failure(self, file_path: str | None = None, reason: str | None = None) -> None:
        """Record one file that could not be converted."""
        with self._lock:
            self._processed_files += 1
            self._failed_files += 1
            if file_path and reason:
                self._failure_details.append((file_path, reason))

    def failure_details(self) -> list[tuple[str, str]]:
        """Return a stable copy of every failed file and its reason."""
        with self._lock:
            return list(self._failure_details)

    def finish(
        self,
        status: ProgressStatus,
        elapsed_seconds: float,
        error: str | None = None,
    ) -> None:
        """Mark the run as finished with a terminal status."""
        if status not in TERMINAL_STATUSES:
            msg = f"'{status}' is not a terminal status"
            raise ValueError(msg)
        with self._lock:
            self._status = status
            self._error = error
            self._elapsed_seconds = max(0.0, elapsed_seconds)

    def set_output_folder(self, path: str) -> None:
        """Set the output folder path after conversion starts."""
        with self._lock:
            self._output_folder = path

    def set_source_folder(self, path: str) -> None:
        """Set the source folder path for reference."""
        with self._lock:
            self._source_folder = path

    def set_current_file(self, file_name: str | None) -> None:
        """Set the file currently being processed (shown in the live UI)."""
        with self._lock:
            self._current_file = file_name

    # -- read-only accessors ----------------------------------------------------

    @property
    def status(self) -> ProgressStatus:
        with self._lock:
            return self._status

    @property
    def total_files(self) -> int:
        with self._lock:
            return self._total_files

    @property
    def processed_files(self) -> int:
        with self._lock:
            return self._processed_files

    @property
    def converted_files(self) -> int:
        with self._lock:
            return self._converted_files

    @property
    def original_bytes(self) -> int:
        with self._lock:
            return self._original_bytes

    @property
    def failed_files(self) -> int:
        with self._lock:
            return self._failed_files

    @property
    def bytes_saved(self) -> int:
        with self._lock:
            return max(0, self._original_bytes - self._converted_bytes)

    @property
    def reduction_percent(self) -> float:
        """Percentage of the original size saved; 0.0 when nothing processed."""
        with self._lock:
            if self._original_bytes <= 0:
                return 0.0
            saved = self._original_bytes - self._converted_bytes
            return (saved / self._original_bytes) * 100.0

    def fraction_complete(self) -> float:
        """Fraction of files processed, in [0.0, 1.0]."""
        with self._lock:
            if self._total_files <= 0:
                return 0.0
            return min(1.0, self._processed_files / self._total_files)

    @property
    def current_file(self) -> str | None:
        with self._lock:
            return self._current_file

    def snapshot(self) -> dict[str, Any]:
        """Return a consistent JSON-serializable view of the current state."""
        with self._lock:
            saved = max(0, self._original_bytes - self._converted_bytes)
            reduction = (saved / self._original_bytes * 100.0) if self._original_bytes > 0 else 0.0
            fraction = (
                min(1.0, self._processed_files / self._total_files)
                if self._total_files > 0
                else 0.0
            )
            return {
                "status": self._status,
                "error": self._error,
                "total_files": self._total_files,
                "processed_files": self._processed_files,
                "converted_files": self._converted_files,
                "failed_files": self._failed_files,
                "original_bytes": self._original_bytes,
                "converted_bytes": self._converted_bytes,
                "bytes_saved": saved,
                "reduction_percent": round(reduction, 2),
                "fraction_complete": round(fraction, 4),
                "elapsed_seconds": round(self._elapsed_seconds, 2),
                "output_folder": self._output_folder,
                "source_folder": self._source_folder,
                "current_file": self._current_file,
            }

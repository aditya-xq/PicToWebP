"""Machine-readable reports for agents and CI.

Two stable payloads are defined here:

* ``pictowebp.result/v1`` — the outcome of one conversion run.
* ``pictowebp.info/v1`` — tool metadata and capabilities (never touches the
  network, so it is safe to call in an offline or privacy-sensitive context).

Keep both additive: agents branch on ``schema`` and ``capabilities`` rather
than on version numbers.
"""

from __future__ import annotations

import json
import platform
import shutil
import sys
from pathlib import Path
from typing import Any

from pictowebp import __version__
from pictowebp.output import emit
from pictowebp.style import sanitize

RESULT_SCHEMA = "pictowebp.result/v1"
INFO_SCHEMA = "pictowebp.info/v1"
ERROR_SCHEMA = "pictowebp.error/v1"

#: Failures embedded in a JSON result before the list is truncated.
MAX_JSON_FAILURES = 100

#: Features a caller may rely on. Skills branch on this list.
CAPABILITIES: tuple[str, ...] = (
    "json",
    "info",
    "non_interactive",
    "interactive",
    "dry_run",
    "out_dir",
    "single_file",
    "fail_on_error",
    "fail_on_empty",
    "lossless",
    "keep_metadata",
)


def emit_json(payload: dict[str, Any]) -> None:
    """Write one compact JSON object to stdout."""
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    print(text, file=sys.stdout, flush=True)


def tool_info() -> dict[str, Any]:
    return {
        "name": "pictowebp",
        "edition": "python",
        "version": __version__,
        "target": platform_target(),
    }


def platform_target() -> str:
    """Return a normalized ``<arch>-<os>`` label shared with the Rust build."""
    machine = platform.machine().lower()
    arch = {
        "amd64": "x86_64",
        "x64": "x86_64",
        "arm64": "aarch64",
        "aarch64": "aarch64",
    }.get(machine, machine)
    os_name = {
        "win32": "windows",
        "darwin": "macos",
    }.get(sys.platform, sys.platform)
    return f"{arch}-{os_name}"


def _executable_path() -> str | None:
    """Best-effort path to the running console script.

    ``python -m pictowebp`` sets ``sys.argv[0]`` to ``__main__.py``; in that
    case report the console script only when it lives in the active
    environment, so a different edition earlier on PATH is never reported.
    """
    if not sys.argv or not sys.argv[0]:
        return None
    argv0 = Path(sys.argv[0])
    if argv0.name == "__main__.py":
        discovered = shutil.which("pictowebp")
        if discovered:
            candidate = Path(discovered).resolve()
            if candidate.parent == Path(sys.executable).resolve().parent:
                return str(candidate)
        return None
    return str(argv0.resolve())


def build_info() -> dict[str, Any]:
    """Build the ``pictowebp.info/v1`` payload."""
    return {
        "schema": INFO_SCHEMA,
        "name": "pictowebp",
        "edition": "python",
        "version": __version__,
        "target": platform_target(),
        "exe": _executable_path(),
        "capabilities": list(CAPABILITIES),
    }


def build_result(
    *,
    source: Path,
    output_folder: Path | None,
    dry_run: bool,
    cancelled: bool,
    settings: Any,
    counts: dict[str, int],
    bytes_summary: dict[str, float],
    duration_ms: int,
    failures: list[dict[str, str]],
    report_path: Path | None,
) -> dict[str, Any]:
    """Build the ``pictowebp.result/v1`` payload."""
    truncated = len(failures) > MAX_JSON_FAILURES
    return {
        "schema": RESULT_SCHEMA,
        "ok": not cancelled and counts["failed"] == 0 and counts["collisions"] == 0,
        "tool": tool_info(),
        "source": str(source),
        "output": str(output_folder.resolve()) if output_folder is not None else None,
        "dry_run": dry_run,
        "cancelled": cancelled,
        "settings": {
            "quality": settings.quality,
            "lossless": settings.lossless,
            "threads": settings.threads,
            "max_pixels": settings.max_pixels,
            "metadata": "strip" if settings.strip_metadata else "keep",
        },
        "counts": counts,
        "bytes": bytes_summary,
        "duration_ms": duration_ms,
        "failures": failures[:MAX_JSON_FAILURES],
        "failures_truncated": truncated,
        "report": str(report_path) if report_path is not None else None,
    }


def error_payload(message: str) -> dict[str, str]:
    return {"schema": ERROR_SCHEMA, "error": message}


def print_info_human() -> None:
    """Print the human-readable ``--info`` block."""
    info = build_info()
    emit("")
    emit(f"  PicToWebP {info['version']} (python)")
    emit(f"  Edition:      {info['edition']}")
    emit(f"  Platform:     {info['target']}")
    emit(f"  Executable:   {sanitize(info['exe'])}")
    emit(f"  Capabilities: {', '.join(CAPABILITIES)}")
    emit("")


def failures_from_details(details: list[tuple[str, str]]) -> list[dict[str, str]]:
    """Convert ``(path, reason)`` pairs into report-shaped failures."""
    from pictowebp.utils import categorize_conversion_error

    return [
        {
            "path": path,
            "category": categorize_conversion_error(reason),
            "message": reason,
        }
        for path, reason in details
    ]


def stream_is_interactive() -> bool:
    """True when both stdin and stdout are terminals."""
    return sys.stdin.isatty() and sys.stdout.isatty()

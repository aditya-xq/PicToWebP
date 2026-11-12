"""Resolution of the conversion output folder."""

from __future__ import annotations

import os
import sys
from datetime import datetime
from pathlib import Path

from pictowebp.enums import OutputImageFormat


def resolve_output_folder(
    source_folder: Path,
    output_format: OutputImageFormat,
    *,
    requested: Path | None = None,
    single_file: bool = False,
    dry_run: bool = False,
) -> Path | None:
    """Resolve where converted files should be written.

    * ``requested`` (``--out``) wins when supplied. It must be missing or empty;
      an existing non-empty folder is rejected instead of merged into, so a run
      can never overwrite unrelated files.
    * A single-file run without ``--out`` writes the ``.webp`` next to the source.
    * A folder run without ``--out`` creates ``<source>_webp_<timestamp>``.
    * A dry run creates nothing and returns ``None`` when the final folder name
      cannot be known ahead of time.
    """
    if requested is not None:
        if not single_file and is_inside(requested, source_folder):
            msg = f"Output folder must not be inside the source folder: {requested}"
            raise ValueError(msg)
        if requested.exists():
            if not requested.is_dir():
                msg = f"Output path is not a folder: {requested}"
                raise ValueError(msg)
            if any(requested.iterdir()):
                msg = (
                    f"Output folder is not empty: {requested}. "
                    "Choose a new folder or remove its contents."
                )
                raise ValueError(msg)
        elif not dry_run:
            requested.mkdir(parents=True)
        return requested

    if single_file:
        return source_folder

    if dry_run:
        return None

    return _create_sibling_folder(source_folder, output_format)


def _create_sibling_folder(source_folder: Path, output_format: OutputImageFormat) -> Path:
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


def is_inside(candidate: Path, root: Path) -> bool:
    """True when ``candidate`` is the same as, or nested under, ``root``."""
    candidate_parts = _comparable(candidate)
    root_parts = _comparable(root)
    return candidate_parts[: len(root_parts)] == root_parts


def _comparable(path: Path) -> tuple[str, ...]:
    resolved = path.resolve()
    parts = resolved.parts
    # Windows and default macOS filesystems are case-insensitive; compare the
    # same way so `--out .../SRC/out` cannot slip past an `.../src` root.
    if os.name == "nt" or sys.platform == "darwin":
        return tuple(part.casefold() for part in parts)
    return parts

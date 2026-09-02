"""Resolution of the conversion output folder."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from pictowebp.enums import OutputImageFormat


def resolve_output_folder(source_folder: Path, output_format: OutputImageFormat) -> Path:
    """Create a unique output folder next to the source folder.

    The folder is named ``<source>_<format>_<timestamp>`` so repeated runs
    never clash.
    """
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

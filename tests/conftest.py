"""Shared pytest fixtures."""

from collections.abc import Callable
from datetime import datetime
from pathlib import Path

import pytest
from PIL import Image


class FixedDatetime(datetime):
    """Deterministic stand-in for ``datetime`` used when patching output folder names."""

    @classmethod
    def now(cls) -> datetime:
        return cls(2026, 8, 26, 12, 30, 45)


@pytest.fixture()
def source_dir(tmp_path: Path) -> Path:
    """An empty source directory ready to receive generated images."""
    directory = tmp_path / "source"
    directory.mkdir()
    return directory


@pytest.fixture()
def image_factory(source_dir: Path) -> Callable[..., Path]:
    """Create images inside ``source_dir``, creating sub-directories as needed."""

    def _make(relative_name: str, *, mode: str = "RGB", size: tuple[int, int] = (24, 24)) -> Path:
        path = source_dir / relative_name
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            path.write_text("not an image", encoding="utf-8")
            return path
        color = (255, 0, 0, 128) if mode == "RGBA" else (200, 50, 50)
        Image.new(mode, size, color).save(path)
        return path

    return _make

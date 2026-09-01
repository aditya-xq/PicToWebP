"""Shared pytest fixtures."""

from collections.abc import Callable
from datetime import datetime, tzinfo
from pathlib import Path
from typing import Any

import pytest
from PIL import Image


@pytest.fixture(autouse=True)
def _hermetic_log_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep ``pictowebp.log`` out of the repo root during tests.

    In-process ``main()`` / ``create_app()`` calls write their log into the
    per-test temp folder (auto-cleaned) instead of the working directory, so a
    green run leaves no stray log behind.
    """
    from pictowebp import cli
    from pictowebp.logging_setup import setup_logging as real_setup
    from pictowebp.web import app as web_app

    def _setup(*args: Any, log_file: Path | None = None, **kwargs: Any) -> None:
        real_setup(*args, log_file=log_file or tmp_path / "pictowebp.log", **kwargs)

    monkeypatch.setattr(cli, "setup_logging", _setup)
    monkeypatch.setattr(web_app, "setup_logging", _setup)


class FixedDatetime(datetime):
    """Deterministic stand-in for ``datetime`` used when patching output folder names."""

    @classmethod
    def now(cls, tz: tzinfo | None = None) -> datetime:
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

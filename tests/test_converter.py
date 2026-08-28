"""End-to-end tests for the conversion engine."""

from pathlib import Path

import pytest

from conftest import FixedDatetime
from pictowebp.converter import convert_folder


def _output_dirs(source: Path) -> list[Path]:
    return [p for p in source.parent.iterdir() if p.is_dir() and p != source]


def test_convert_folder_converts_nested_tree(image_factory, source_dir):
    image_factory("one.png")
    image_factory("nested/two.jpg")
    image_factory("nested/deep/three.jpeg")
    (source_dir / "skip.txt").write_text("not an image", encoding="utf-8")

    progress = convert_folder(source_dir, quality=80, threads=2, show_progress_bar=False)

    assert progress.status == "completed"
    assert progress.total_files == 3
    assert progress.converted_files == 3
    assert progress.failed_files == 0
    assert progress.snapshot()["elapsed_seconds"] >= 0.0

    output_folders = _output_dirs(source_dir)
    assert len(output_folders) == 1
    converted = sorted(
        p.relative_to(output_folders[0]).as_posix() for p in output_folders[0].rglob("*.webp")
    )
    assert converted == ["nested/deep/three.webp", "nested/two.webp", "one.webp"]


def test_convert_folder_empty_source_creates_nothing(source_dir):
    progress = convert_folder(source_dir, threads=2, show_progress_bar=False)

    assert progress.status == "idle"
    assert progress.total_files == 0
    assert not _output_dirs(source_dir)


def test_convert_folder_writes_failure_report_and_uses_effective_workers(image_factory, source_dir):
    image_factory("valid.png")
    corrupt = source_dir / "broken.jpg"
    corrupt.write_bytes(b"not an image")
    started: list[tuple[Path, int]] = []

    progress = convert_folder(
        source_dir,
        threads=8,
        show_progress_bar=False,
        on_started=lambda output, workers: started.append((output, workers)),
    )

    assert progress.converted_files == 1
    assert progress.failed_files == 1
    assert started and started[0][1] == 2
    report = started[0][0] / "conversion-errors.txt"
    assert str(corrupt.resolve()) in report.read_text(encoding="utf-8")
    assert "Corrupt or mislabeled image" in report.read_text(encoding="utf-8")


def test_convert_folder_reuses_unique_output_when_colliding(monkeypatch, image_factory, source_dir):
    monkeypatch.setattr("pictowebp.utils.datetime", FixedDatetime)
    image_factory("a.png")

    convert_folder(source_dir, threads=1, show_progress_bar=False)
    convert_folder(source_dir, threads=1, show_progress_bar=False)

    folders = _output_dirs(source_dir)
    assert len(folders) == 2
    assert all(folder.is_dir() for folder in folders)


def test_convert_folder_reports_colliding_inputs(image_factory, source_dir):
    from PIL import Image

    image_factory("photo.png")
    Image.new("RGB", (16, 16), (255, 0, 0)).save(source_dir / "photo.jpg")

    progress = convert_folder(source_dir, threads=2, show_progress_bar=False)

    assert progress.converted_files == 0
    assert progress.failed_files == 2
    reasons = [reason for _path, reason in progress.failure_details()]
    assert any("map to the same output" in reason for reason in reasons)
    folders = _output_dirs(source_dir)
    assert len(folders) == 1
    assert not any(folders[0].rglob("*.webp"))


def test_convert_folder_callback_exception_finishes_as_failed(image_factory, source_dir):
    image_factory("a.png")

    def callback(_output: Path, _workers: int) -> None:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        convert_folder(
            source_dir,
            threads=1,
            show_progress_bar=False,
            on_started=callback,
        )

    folders = _output_dirs(source_dir)
    assert folders and folders[0].is_dir()


def test_convert_folder_writes_report_to_custom_path(image_factory, source_dir, tmp_path):
    image_factory("a.png")
    (source_dir / "broken.jpg").write_bytes(b"not an image")

    custom = tmp_path / "errors.txt"
    progress = convert_folder(
        source_dir,
        threads=1,
        show_progress_bar=False,
        report_path=custom,
    )

    assert progress.failed_files == 1
    assert custom.is_file()
    # Default location must not be written when a custom path is supplied.
    output_folders = _output_dirs(source_dir)
    assert not (output_folders[0] / "conversion-errors.txt").exists()


def test_convert_folder_does_not_write_report_when_no_failures(image_factory, source_dir):
    image_factory("a.png")

    progress = convert_folder(
        source_dir,
        threads=1,
        show_progress_bar=False,
        report_path=source_dir / "should-not-exist.txt",
    )

    assert progress.failed_files == 0
    assert not (source_dir / "should-not-exist.txt").exists()


def test_convert_folder_cancellation_marks_cancelled(image_factory, source_dir):
    """When cancellation is requested, the tracker should end as ``cancelled``."""
    from pictowebp import converter

    image_factory("a.png")
    image_factory("b.png")

    def trigger() -> None:
        converter.request_cancellation()

    progress = convert_folder(
        source_dir,
        threads=1,
        show_progress_bar=False,
        on_started=lambda _output, _workers: trigger(),
    )

    assert progress.status == "cancelled"


def test_request_cancellation_returns_false_when_no_active_run():
    from pictowebp import converter

    assert converter.request_cancellation() is False

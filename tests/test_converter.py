"""End-to-end tests for the conversion engine (batch + per-file)."""

from pathlib import Path

import pytest
from PIL import Image

from conftest import FixedDatetime
from pictowebp.converter import ConversionError, ProcessedFile, convert_folder, process_file
from pictowebp.enums import OutputImageFormat


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
    monkeypatch.setattr("pictowebp.paths.datetime", FixedDatetime)
    image_factory("a.png")

    convert_folder(source_dir, threads=1, show_progress_bar=False)
    convert_folder(source_dir, threads=1, show_progress_bar=False)

    folders = _output_dirs(source_dir)
    assert len(folders) == 2
    assert all(folder.is_dir() for folder in folders)


def test_convert_folder_reports_colliding_inputs(image_factory, source_dir):
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


# -- per-file conversion -----------------------------------------------------


def test_process_file_converts_and_returns_sizes(image_factory, source_dir):
    original = image_factory("photo.png")
    output_root = source_dir.parent / "out"
    output_root.mkdir()

    result = process_file(original, source_dir, output_root, 80, OutputImageFormat.WEBP)

    assert isinstance(result, ProcessedFile)
    converted_path = output_root / "photo.webp"
    assert converted_path.is_file()
    assert result.original_bytes == original.stat().st_size > 0
    assert result.converted_bytes > 0


def test_process_file_preserves_alpha(image_factory, source_dir):
    original = image_factory("transparent.png", mode="RGBA")
    output_root = source_dir.parent / "out"
    output_root.mkdir()

    process_file(original, source_dir, output_root, 80, OutputImageFormat.WEBP)

    with Image.open(output_root / "transparent.webp") as converted:
        assert converted.mode == "RGBA"


def test_process_file_converts_palette_mode_to_rgba(source_dir):
    """Palette images with transparency must land as RGBA, not RGB."""
    palette = Image.new("P", (16, 16))
    palette.putpalette([255, 0, 0, 0, 255, 0, 0, 0, 255] + [0, 0, 0] * 253)
    palette.info["transparency"] = 2
    palette.putpixel((0, 0), 2)  # actually use the transparent palette index
    path = source_dir / "palette.png"
    palette.save(path)

    output_root = source_dir.parent / "out"
    output_root.mkdir()
    result = process_file(path, source_dir, output_root, 80, OutputImageFormat.WEBP)
    assert isinstance(result, ProcessedFile)

    with Image.open(output_root / "palette.webp") as converted:
        assert converted.mode == "RGBA"


def test_process_file_survives_decompression_bomb(image_factory, source_dir, monkeypatch):
    """A Pillow DecompressionBombError must be a per-file skip, not a crash."""
    image_factory("bomb.png")
    output_root = source_dir.parent / "out"
    output_root.mkdir()
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 16)

    result = process_file(
        source_dir / "bomb.png", source_dir, output_root, 80, OutputImageFormat.WEBP
    )

    assert isinstance(result, ConversionError)
    assert not (output_root / "bomb.webp").exists()


def _convert_with_size(source_dir, width, height, **kwargs):
    """Create an image of the given size, convert it, return the output size."""
    path = source_dir / "resized.png"
    Image.new("RGB", (width, height), (5, 5, 5)).save(path)
    output_root = source_dir.parent / "out"
    output_root.mkdir(exist_ok=True)
    result = process_file(path, source_dir, output_root, 80, OutputImageFormat.WEBP, **kwargs)
    assert isinstance(result, ProcessedFile)
    with Image.open(output_root / "resized.webp") as converted:
        return converted.size


def test_resize_width_only_preserves_aspect_ratio(source_dir):
    assert _convert_with_size(source_dir, 640, 480, resize_width=320) == (320, 240)


def test_resize_height_only_preserves_aspect_ratio(source_dir):
    assert _convert_with_size(source_dir, 640, 480, resize_height=240) == (320, 240)


def test_resize_fits_within_both_bounds(source_dir):
    assert _convert_with_size(source_dir, 1000, 500, resize_width=320, resize_height=100) == (
        200,
        100,
    )


def test_resize_never_upscales(source_dir):
    assert _convert_with_size(source_dir, 100, 50, resize_width=320, resize_height=320) == (
        100,
        50,
    )


def test_resize_never_produces_zero_dimension(source_dir):
    """Pathological aspect ratios must collapse no dimension to zero (matches CLIs)."""
    assert _convert_with_size(source_dir, 100000, 1, resize_width=16)[1] == 1
    assert _convert_with_size(source_dir, 1, 100000, resize_height=16)[0] == 1


def test_process_file_mirrors_nested_structure(image_factory, source_dir):
    original = image_factory("nested/deep/photo.jpg")
    output_root = source_dir.parent / "out"
    output_root.mkdir()

    process_file(original, source_dir, output_root, 80, OutputImageFormat.WEBP)

    assert (output_root / "nested" / "deep" / "photo.webp").is_file()


def test_process_file_skips_corrupt_files(source_dir):
    corrupt = source_dir / "broken.png"
    corrupt.write_bytes(b"this is not an image")
    output_root = source_dir.parent / "out"
    output_root.mkdir()

    result = process_file(corrupt, source_dir, output_root, 80, OutputImageFormat.WEBP)
    assert isinstance(result, ConversionError)
    assert result.file_path == corrupt
    assert result.reason


def test_process_file_strips_metadata_by_default(source_dir):
    """Default ``strip_metadata=True`` must drop EXIF tags from the output."""
    from PIL.ExifTags import Base as ExifBase

    image = Image.new("RGB", (16, 16), (10, 20, 30))
    exif = image.getexif()
    exif[ExifBase.Make] = b"TestCamera"
    path = source_dir / "with_exif.jpg"
    image.save(path, exif=exif.tobytes())

    output_root = source_dir.parent / "out"
    output_root.mkdir()
    result = process_file(path, source_dir, output_root, 80, OutputImageFormat.WEBP)
    assert isinstance(result, ProcessedFile)

    with Image.open(output_root / "with_exif.webp") as converted:
        assert dict(converted.getexif()) == {}


def test_process_file_keeps_metadata_when_requested(source_dir):
    """``strip_metadata=False`` must carry the source EXIF into the output."""
    from PIL.ExifTags import Base as ExifBase

    image = Image.new("RGB", (16, 16), (10, 20, 30))
    exif = image.getexif()
    exif[ExifBase.Make] = "TestCamera"
    path = source_dir / "with_exif.jpg"
    image.save(path, exif=exif.tobytes())

    output_root = source_dir.parent / "out"
    output_root.mkdir()
    result = process_file(
        path, source_dir, output_root, 80, OutputImageFormat.WEBP, strip_metadata=False
    )
    assert isinstance(result, ProcessedFile)

    with Image.open(output_root / "with_exif.webp") as converted:
        assert converted.getexif().get(ExifBase.Make) == "TestCamera"


def test_process_file_cleans_up_temp_on_failure(source_dir):
    """On encoder failure the temp file is removed; no leftover ``.tmp`` files remain."""
    source_dir.mkdir(exist_ok=True)
    output_root = source_dir.parent / "out"
    output_root.mkdir()

    # A file whose name has a valid suffix but whose contents are not a real image.
    bad = source_dir / "broken.png"
    bad.write_bytes(b"not an image")

    result = process_file(bad, source_dir, output_root, 80, OutputImageFormat.WEBP)
    assert isinstance(result, ConversionError)

    # The destination should not exist, and no ``.tmp`` leftovers should remain.
    assert not (output_root / "broken.webp").exists()
    leftovers = list(output_root.glob("*.tmp"))
    assert leftovers == [], f"unexpected temp files: {leftovers}"


def test_process_file_handles_same_stem_in_subdirectories(source_dir):
    """Two images with the same stem in different subdirs should both convert successfully."""
    first = source_dir / "a" / "photo.png"
    first.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), (1, 2, 3)).save(first)

    second = source_dir / "b" / "photo.png"
    second.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), (4, 5, 6)).save(second)

    output_root = source_dir.parent / "out"
    output_root.mkdir()

    r1 = process_file(first, source_dir, output_root, 80, OutputImageFormat.WEBP)
    r2 = process_file(second, source_dir, output_root, 80, OutputImageFormat.WEBP)
    assert isinstance(r1, ProcessedFile)
    assert isinstance(r2, ProcessedFile)
    assert (output_root / "a" / "photo.webp").is_file()
    assert (output_root / "b" / "photo.webp").is_file()

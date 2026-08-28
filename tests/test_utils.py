"""Tests for filesystem helpers in pictowebp.utils."""

import pytest
from PIL import Image

from conftest import FixedDatetime
from pictowebp.enums import OutputImageFormat
from pictowebp.utils import (
    ConversionError,
    DiskSpaceInfo,
    ProcessedFile,
    categorize_conversion_error,
    check_disk_space,
    discover_images,
    process_file,
    resolve_output_folder,
)


def test_discover_images_finds_supported_formats_recursively(image_factory, source_dir):
    image_factory("a.png")
    image_factory("nested/b.jpg")
    image_factory("nested/deep/c.jpeg")
    image_factory("d.webp")
    image_factory("ignored.txt")

    assert discover_images(source_dir) == sorted(
        [
            source_dir / "a.png",
            source_dir / "d.webp",
            source_dir / "nested" / "b.jpg",
            source_dir / "nested" / "deep" / "c.jpeg",
        ]
    )


def test_discover_images_case_insensitive(image_factory, source_dir):
    image_factory("UPPER.PNG")
    image_factory("lower.jpg")
    assert discover_images(source_dir) == sorted(
        [source_dir / "UPPER.PNG", source_dir / "lower.jpg"]
    )


def test_discover_images_empty(source_dir):
    assert discover_images(source_dir) == []


def test_discover_images_skips_hidden_directories(image_factory, source_dir):
    image_factory("visible.png")
    hidden = source_dir / ".hidden"
    hidden.mkdir()
    Image.new("RGB", (8, 8)).save(hidden / "secret.jpg")

    assert discover_images(source_dir) == [source_dir / "visible.png"]


def test_discover_images_includes_all_supported_formats(image_factory, source_dir):
    for name in ("pic.bmp", "pic.tiff", "pic.gif"):
        Image.new("RGB", (8, 8)).save(source_dir / name)
    image_factory("pic.png")

    found = {p.name for p in discover_images(source_dir)}
    assert found == {"pic.bmp", "pic.tiff", "pic.gif", "pic.png"}


def test_discover_images_ignores_symlinked_directories(image_factory, source_dir):
    """Symlinked directories must not be followed (infinite-loop guard)."""
    image_factory("real.png")
    link = source_dir / "loop"
    try:
        link.symlink_to(source_dir, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks not supported on this platform")

    assert discover_images(source_dir) == [source_dir / "real.png"]


def test_resolve_output_folder_creates_sibling(source_dir):
    output = resolve_output_folder(source_dir, OutputImageFormat.WEBP)
    assert output.parent == source_dir.parent
    assert output.name.startswith(f"{source_dir.name}_webp_")
    assert output.is_dir()


def test_resolve_output_folder_creates_unique_folders(source_dir):
    first = resolve_output_folder(source_dir, OutputImageFormat.WEBP)
    second = resolve_output_folder(source_dir, OutputImageFormat.WEBP)
    assert first.is_dir()
    assert second.is_dir()
    assert first != second


def test_resolve_output_folder_collision_suffixed(monkeypatch, source_dir):
    monkeypatch.setattr("pictowebp.utils.datetime", FixedDatetime)
    base = source_dir.parent / f"{source_dir.name}_webp_20260826_123045_000000"
    base.mkdir()

    output = resolve_output_folder(source_dir, OutputImageFormat.WEBP)
    assert output != base
    assert output.is_dir()


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


def test_categorize_conversion_error_common_cases():
    assert (
        categorize_conversion_error("cannot identify image file") == "Corrupt or mislabeled image"
    )
    assert categorize_conversion_error("Permission denied") == "Permission denied"
    assert categorize_conversion_error("File not found") == "Unreadable file"
    assert categorize_conversion_error("No space left on device") == "Output write failed"
    assert categorize_conversion_error("some random failure") == "Conversion failed"


def test_check_disk_space_returns_structured_info(source_dir):
    info = check_disk_space(source_dir)
    assert isinstance(info, DiskSpaceInfo)
    # `free_bytes` is None on Windows (stdlib limitation) but `low` is always bool.
    assert isinstance(info.low, bool)


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

"""Tests for recursive image discovery."""

import pytest
from PIL import Image

from pictowebp.discovery import discover_images


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

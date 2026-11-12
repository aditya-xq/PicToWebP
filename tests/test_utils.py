"""Tests for miscellaneous helpers in pictowebp.utils."""

from pictowebp.utils import DiskSpaceInfo, categorize_conversion_error, check_disk_space


def test_categorize_conversion_error_common_cases():
    assert (
        categorize_conversion_error("cannot identify image file") == "Corrupt or mislabeled image"
    )
    assert categorize_conversion_error("Permission denied") == "Permission denied"
    assert categorize_conversion_error("image is too large: 20000x20000") == "Image too large"
    assert categorize_conversion_error("File not found") == "Unreadable file"
    assert categorize_conversion_error("No space left on device") == "Output write failed"
    assert categorize_conversion_error("some random failure") == "Conversion failed"


def test_check_disk_space_returns_structured_info(source_dir):
    info = check_disk_space(source_dir)
    assert isinstance(info, DiskSpaceInfo)
    # `free_bytes` is None on Windows (stdlib limitation) but `low` is always bool.
    assert isinstance(info.low, bool)


def test_categorize_conversion_error_distinguishes_collisions_and_overwrites():
    assert (
        categorize_conversion_error("Multiple input files map to the same output: a.webp")
        == "Output name collision"
    )
    assert (
        categorize_conversion_error("Refusing to overwrite C:/pics/a.webp")
        == "Output file already exists"
    )


def test_categorize_conversion_error_ignores_words_inside_paths():
    """A file named ``collision.png`` is still just a corrupt image."""
    assert (
        categorize_conversion_error("cannot identify image file 'C:/photos/collision.png'")
        == "Corrupt or mislabeled image"
    )
    assert (
        categorize_conversion_error("cannot identify image file 'C:/photos/already exists.jpg'")
        == "Corrupt or mislabeled image"
    )

"""Tests for miscellaneous helpers in pictowebp.utils."""

from pictowebp.utils import DiskSpaceInfo, categorize_conversion_error, check_disk_space


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

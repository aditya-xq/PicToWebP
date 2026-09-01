"""Tests for unique output-folder resolution."""

from conftest import FixedDatetime
from pictowebp.enums import OutputImageFormat
from pictowebp.paths import resolve_output_folder


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
    monkeypatch.setattr("pictowebp.paths.datetime", FixedDatetime)
    base = source_dir.parent / f"{source_dir.name}_webp_20260826_123045_000000"
    base.mkdir()

    output = resolve_output_folder(source_dir, OutputImageFormat.WEBP)
    assert output != base
    assert output.is_dir()

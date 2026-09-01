"""Live end-to-end tests that run the real CLI entry point as a subprocess.

Unlike the in-process ``main()`` tests, these spawn ``python -m pictowebp``
against a fresh copy of the shared fixture corpus (``tests/e2e/fixtures``),
exercising the actual process boundary, argument parsing, progress output,
exit codes, output-folder allocation and crash-safe writes — then pytest's
``tmp_path`` removes everything afterwards.

Expected corpus behaviour (Python discovers png/jpeg/webp/bmp/tiff/gif):
    * converted: a b c d e f, nested/deep/leaf (7 webp)
    * failed:    broken.png (corrupt)
    * skipped:   dup.png + dup.jpg (same-stem collision -> ambiguous target, both skipped)
    * ignored:   .hidden/  (dot-directory)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from time import perf_counter
from typing import Any

import pytest
from PIL import Image


def _load_perf() -> Any:
    """Load the sibling perf helper without relying on package imports."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "perf", Path(__file__).resolve().parent / "perf.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


perf = _load_perf()

FIXTURES = Path(__file__).resolve().parent / "fixtures"
REAL_IMAGES = Path(__file__).resolve().parent / "real_images"
DOWNLOAD_SCRIPT = Path(__file__).resolve().parent / "download_real_dataset.py"
REAL_COUNT = 500

ARGS = ["-q", "80", "-t", "2", "--no-progress", "--no-log"]


def copy_corpus(dest: Path) -> Path:
    """Clone the shared fixture corpus into ``dest/source``."""
    source = dest / "source"
    source.mkdir(parents=True)
    for fixture in FIXTURES.rglob("*"):
        if fixture.is_file():
            relative = fixture.relative_to(FIXTURES)
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(fixture.read_bytes())
    return source


def run_cli(source: Path, *extra: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    """Run the real CLI against ``source`` and return the completed process."""
    return subprocess.run(
        [sys.executable, "-m", "pictowebp", str(source), *ARGS, *extra],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=240,
    )


def output_folder(source: Path) -> Path:
    """Locate the unique ``<source>_webp_<timestamp>`` folder created next to source."""
    candidates = sorted(p for p in source.parent.iterdir() if p.is_dir() and p != source)
    assert candidates, "expected a <source>_webp_<timestamp> output folder"
    assert len(candidates) == 1, "expected exactly one output folder per run"
    return candidates[0]


def latest_output_folder(source: Path) -> Path:
    """Newest output folder (for tests that run the CLI more than once)."""
    candidates = sorted(p for p in source.parent.iterdir() if p.is_dir() and p != source)
    assert candidates, "expected at least one <source>_webp_<timestamp> output folder"
    return candidates[-1]


def converted_webp(output: Path) -> list[str]:
    """Sorted relative paths of every converted file (hidden output would show up here)."""
    return sorted(str(p.relative_to(output)) for p in output.rglob("*.webp"))


@pytest.fixture()
def source(tmp_path: Path) -> Path:
    """A fresh copy of the corpus plus a scratch cwd for the subprocess."""
    return copy_corpus(tmp_path)


def test_happy_path_converts_every_supported_format(source: Path):
    """All convertible formats produce valid WebP files; no partial output."""
    proc = run_cli(source, cwd=source.parent)
    assert proc.returncode == 0, proc.stdout + proc.stderr

    output = output_folder(source)
    expected = [
        "a.webp",
        "b.webp",
        "c.webp",
        "d.webp",
        "e.webp",
        "f.webp",
        str(Path("nested/deep/leaf.webp")),
    ]
    assert converted_webp(output) == sorted(expected)

    # The corrupt file must never produce output (crash-safe: only fully
    # converted files appear), and hidden directories are skipped entirely.
    assert not (output / "broken.webp").exists()
    assert not any(".hidden" in str(p) for p in converted_webp(output))

    # Every output is a real WebP image.
    for webp in output.rglob("*.webp"):
        with Image.open(webp) as img:
            assert img.format == "WEBP"


def test_same_stem_collision_is_skipped_and_reported(source: Path):
    """dup.png + dup.jpg both map to dup.webp — the ambiguous target is skipped
    for BOTH inputs and reported; nothing is ever silently overwritten."""
    proc = run_cli(source, cwd=source.parent)
    assert proc.returncode == 0

    output = output_folder(source)
    # Neither input may claim the shared target.
    assert not (output / "dup.webp").exists()
    assert not list(output.glob("dup*.webp"))

    report = (output / "conversion-errors.txt").read_text(encoding="utf-8")
    assert "dup.jpg" in report
    assert "dup.png" in report
    assert "dup.webp" in report  # reason names the ambiguous target


def test_hidden_directory_is_never_converted(source: Path):
    run_cli(source, cwd=source.parent)
    assert not any(".hidden" in str(p) for p in output_folder(source).rglob("*"))


def test_failure_report_lists_corrupt_file(source: Path):
    """A mixed batch exits 0 but persists an error report for the bad file."""
    proc = run_cli(source, cwd=source.parent)
    assert proc.returncode == 0
    report = (output_folder(source) / "conversion-errors.txt").read_text(encoding="utf-8")
    assert "broken.png" in report


def test_all_broken_input_exits_3(tmp_path: Path):
    """When nothing converts, the process signals a hard failure (exit 3)."""
    source = tmp_path / "source"
    source.mkdir()
    (source / "broken.png").write_bytes(b"not an image")
    proc = run_cli(source, cwd=tmp_path)
    assert proc.returncode == 3


def test_missing_path_exits_2(tmp_path: Path):
    """A nonexistent source path is a usage error (exit 2)."""
    proc = run_cli(tmp_path / "nope", cwd=tmp_path)
    assert proc.returncode == 2


def test_resize_flag_applies_end_to_end(source: Path):
    """--resize-width clamps the real output dimensions (never upscales)."""
    proc = run_cli(source, "--resize-width", "16", cwd=source.parent)
    assert proc.returncode == 0

    leaf = output_folder(source) / "nested" / "deep" / "leaf.webp"
    with Image.open(leaf) as img:
        assert img.size == (16, 8)


def test_output_folder_naming_uses_timestamp(source: Path):
    """The output folder follows the unique `<source>_webp_<timestamp>` contract."""
    run_cli(source, cwd=source.parent)
    name = output_folder(source).name
    assert name.startswith("source_webp_")
    assert name != "source_webp_"


def test_empty_and_no_image_folders_are_noops(tmp_path: Path):
    """Empty folders and folders with no convertible images exit 0 and create
    no output folder (they are not errors, just no-ops)."""
    for name, setup in (
        ("empty", lambda d: None),
        ("only-text", lambda d: (d / "notes.txt").write_text("hello")),
    ):
        source = tmp_path / name
        source.mkdir()
        setup(source)
        proc = run_cli(source, cwd=tmp_path)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert "No convertible images found" in proc.stdout
        assert not list(tmp_path.glob(f"{name}_webp_*"))


def test_keep_metadata_flag_preserves_exif(source: Path):
    """EXIF/GPS is stripped by default; `--keep-metadata` preserves it."""
    cam = source / "cam.png"
    img = Image.new("RGB", (16, 16), (10, 200, 30))
    exif = Image.Exif()
    exif[0x010F] = "PicToWebP Test Camera"  # EXIF Make tag
    img.save(cam, exif=exif)

    proc = run_cli(source, cwd=source.parent)
    assert proc.returncode == 0
    with Image.open(output_folder(source) / "cam.webp") as out:
        assert not out.getexif(), "EXIF must be stripped by default"

    proc = run_cli(source, "--keep-metadata", cwd=source.parent)
    assert proc.returncode == 0
    with Image.open(latest_output_folder(source) / "cam.webp") as out:
        assert out.getexif().get(0x010F) == "PicToWebP Test Camera"


def test_lossless_flag_flow(source: Path):
    """`--lossless` runs end-to-end and still produces valid WebP output."""
    proc = run_cli(source, "--lossless", cwd=source.parent)
    assert proc.returncode == 0
    with Image.open(output_folder(source) / "a.webp") as out:
        assert out.format == "WEBP"


def test_interactive_prompt_flow(tmp_path: Path):
    """Running without a path prompts for folder/quality/threads on stdin and
    still completes a full conversion."""
    source = copy_corpus(tmp_path)
    proc = subprocess.run(
        [sys.executable, "-m", "pictowebp", "--no-progress"],
        input=f"{source}\n\n\n",  # directory, quality (default), threads (default)
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=240,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert output_folder(source).is_dir()


def count_real_images() -> int:
    """Number of images already in the realistic dataset folder (0 if absent)."""
    if not REAL_IMAGES.is_dir():
        return 0
    return sum(
        1
        for p in REAL_IMAGES.rglob("*")
        if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    )


def ensure_real_images(count: int = REAL_COUNT) -> bool:
    """Auto-download the realistic set on demand; False when unavailable.

    Already-downloaded sets are reused as-is (no re-download, no cleanup of
    the source data). Set PICTOWEBP_SKIP_REAL_DOWNLOAD=1 to force-skip.
    """
    if count_real_images() >= count:
        return True
    if os.environ.get("PICTOWEBP_SKIP_REAL_DOWNLOAD"):
        return False
    try:
        subprocess.run(
            [sys.executable, str(DOWNLOAD_SCRIPT), "--count", str(count)],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True,
            text=True,
            timeout=900,
        )
    except Exception:
        return False
    return count_real_images() >= count


def test_realistic_dataset_converts_end_to_end(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    """A full realistic photo set converts end to end with matching output
    counts, and the run's performance metrics are captured for benchmarking."""
    if not ensure_real_images():
        pytest.skip(
            "realistic dataset unavailable (set PICTOWEBP_SKIP_REAL_DOWNLOAD=1 "
            "to force-skip without downloading)"
        )
    n = count_real_images()

    # Work on a copy so the original dataset is never touched or cleaned up.
    source = tmp_path / "real"
    shutil.copytree(REAL_IMAGES, source)

    started = perf_counter()
    proc = run_cli(source, cwd=tmp_path)
    elapsed = perf_counter() - started

    assert proc.returncode == 0, proc.stdout + proc.stderr
    output = output_folder(source)
    assert len(list(output.rglob("*.webp"))) == n, "every realistic photo must convert"
    assert not (output / "conversion-errors.txt").exists(), "no failures expected in the dataset"

    metrics = perf.measure(source, output, elapsed, proc.stdout)
    perf.record("python-cli", metrics)
    print(perf.format_line("python-cli", metrics))

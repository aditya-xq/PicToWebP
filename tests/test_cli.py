"""Tests for the CLI entry point."""

from pathlib import Path

import pytest
from PIL import Image

from pictowebp.cli import build_parser, main, prompt_for_directory, prompt_for_int


def test_parser_accepts_flags(tmp_path: Path):
    args = build_parser().parse_args([str(tmp_path), "-q", "90", "-t", "4"])
    assert args.path == tmp_path
    assert args.quality == 90
    assert args.threads == 4
    assert args.no_progress is False
    assert args.lossless is False
    assert args.keep_metadata is False
    assert args.resize_width is None
    assert args.resize_height is None


def test_parser_accepts_advanced_flags(tmp_path: Path):
    args = build_parser().parse_args(
        [
            str(tmp_path),
            "-q",
            "75",
            "--lossless",
            "--keep-metadata",
            "--resize-width",
            "800",
            "--resize-height",
            "600",
            "--no-progress",
            "--no-log",
            "--report",
            str(tmp_path / "report.txt"),
        ]
    )
    assert args.quality == 75
    assert args.lossless is True
    assert args.keep_metadata is True
    assert args.resize_width == 800
    assert args.resize_height == 600
    assert args.no_progress is True
    assert args.no_log is True
    assert args.report == tmp_path / "report.txt"


def test_parser_rejects_out_of_range_quality():
    try:
        build_parser().parse_args(["-q", "0"])
    except SystemExit:
        pass
    else:
        msg = "expected SystemExit for invalid quality"
        raise AssertionError(msg)


def test_parser_rejects_out_of_range_threads():
    try:
        build_parser().parse_args(["-t", "0"])
    except SystemExit:
        pass
    else:
        msg = "expected SystemExit for invalid threads"
        raise AssertionError(msg)


def test_parser_rejects_out_of_range_resize():
    for flag in ("--resize-width", "--resize-height"):
        try:
            build_parser().parse_args([flag, "1"])
        except SystemExit:
            pass
        else:
            msg = f"expected SystemExit for invalid {flag}"
            raise AssertionError(msg)


def test_prompt_for_directory_retries_then_accepts(monkeypatch, tmp_path: Path):
    answers = iter(["not-a-dir", f'"{tmp_path}"'])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))

    assert prompt_for_directory() == tmp_path.resolve()


def test_prompt_for_directory_reprompts_on_empty(monkeypatch, tmp_path: Path):
    """Empty input must not silently fall back to the current directory."""
    answers = iter(["", str(tmp_path)])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))

    assert prompt_for_directory() == tmp_path.resolve()


def test_prompt_for_int_defaults_and_bounds(monkeypatch):
    answers = iter(["abc", "500", ""])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))

    value = prompt_for_int("Quality", default=80, low=1, high=100)
    assert value == 80


def test_main_runs_full_conversion(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    source = tmp_path / "pics"
    source.mkdir()
    Image.new("RGB", (16, 16), (10, 200, 30)).save(source / "img.png")

    exit_code = main([str(source), "-q", "75", "-t", "2"])

    assert exit_code == 0
    captured = capsys.readouterr()
    # Pretty output goes to stdout via print().
    assert "Images converted: 1/1" in captured.out
    assert "Time taken:" in captured.out


def test_main_returns_error_for_missing_path(tmp_path: Path):
    exit_code = main([str(tmp_path / "does-not-exist"), "-q", "80"])

    assert exit_code == 2


def test_main_returns_partial_failure_status(tmp_path: Path):
    """When most files convert but a few fail, exit 0 (failures are warnings)."""
    source = tmp_path / "pics"
    source.mkdir()
    Image.new("RGB", (16, 16), (10, 200, 30)).save(source / "good.png")
    (source / "broken.png").write_bytes(b"not an image")

    # Mixed batch: 1 success, 1 failure. Should still exit 0.
    assert main([str(source), "-q", "80", "-t", "1", "--no-progress"]) == 0


def test_main_returns_total_failure_status(tmp_path: Path):
    """When no files convert successfully, exit 3."""
    source = tmp_path / "pics"
    source.mkdir()
    (source / "broken.png").write_bytes(b"not an image")

    assert main([str(source), "-q", "80", "-t", "1", "--no-progress"]) == 3


def test_main_lossless_flag_runs(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    source = tmp_path / "pics"
    source.mkdir()
    Image.new("RGB", (16, 16), (10, 200, 30)).save(source / "img.png")

    exit_code = main([str(source), "-q", "80", "--lossless", "-t", "1", "--no-progress"])

    assert exit_code == 0
    captured = capsys.readouterr()
    assert "lossless" in captured.out.lower()


def test_main_resize_flag_runs(tmp_path: Path):
    source = tmp_path / "pics"
    source.mkdir()
    Image.new("RGB", (640, 480), (255, 0, 0)).save(source / "big.png")

    exit_code = main(
        [
            str(source),
            "-q",
            "80",
            "--resize-width",
            "320",
            "-t",
            "1",
            "--no-progress",
        ]
    )

    assert exit_code == 0
    output_folders = [p for p in source.parent.iterdir() if p.is_dir() and p != source]
    assert output_folders, "expected an output folder to be created"
    resized = next(output_folders[0].rglob("big.webp"))
    with Image.open(resized) as img:
        # Width should be 320; height is scaled proportionally.
        assert img.size[0] == 320
        assert img.size[1] < 480


def test_main_keep_metadata_flag_runs(tmp_path: Path):
    source = tmp_path / "pics"
    source.mkdir()
    Image.new("RGB", (16, 16), (10, 200, 30)).save(source / "img.png")

    exit_code = main([str(source), "-q", "80", "--keep-metadata", "-t", "1", "--no-progress"])
    assert exit_code == 0


def test_main_report_path_override(tmp_path: Path):
    source = tmp_path / "pics"
    source.mkdir()
    (source / "broken.png").write_bytes(b"not an image")

    custom_report = tmp_path / "custom-errors.txt"
    exit_code = main(
        [
            str(source),
            "-q",
            "80",
            "-t",
            "1",
            "--no-progress",
            "--report",
            str(custom_report),
        ]
    )
    assert exit_code == 3
    assert custom_report.is_file()
    assert "broken" in custom_report.read_text(encoding="utf-8")


def test_main_no_log_disables_file_logging(tmp_path: Path, monkeypatch):
    import logging

    captured_log_path: list[Path] = []

    def fake_setup(
        level: int = logging.INFO,
        log_file: Path | None = None,
        *,
        disable_file_logging: bool = False,
    ) -> None:
        if log_file and not disable_file_logging:
            captured_log_path.append(log_file)

    monkeypatch.setattr("pictowebp.cli.setup_logging", fake_setup)

    source = tmp_path / "pics"
    source.mkdir()
    Image.new("RGB", (16, 16), (10, 200, 30)).save(source / "img.png")

    exit_code = main([str(source), "-q", "80", "--no-log", "-t", "1", "--no-progress"])
    assert exit_code == 0
    assert captured_log_path == []


def test_main_pipeline_disables_progress_for_non_tty(tmp_path: Path, capsys, monkeypatch):
    """Progress bar is suppressed when stdout is not a TTY (even without --no-progress)."""
    from pictowebp import converter

    used_settings: list[bool] = []
    original = converter.convert_folder

    def spy(*args, **kwargs):
        used_settings.append(kwargs.get("show_progress_bar", True))
        return original(*args, **kwargs)

    monkeypatch.setattr("pictowebp.cli.convert_folder", spy)
    # Simulate piped stdout: capsys already detaches stdout, so isatty() is False.

    source = tmp_path / "pics"
    source.mkdir()
    Image.new("RGB", (16, 16), (10, 200, 30)).save(source / "img.png")

    exit_code = main([str(source), "-q", "80", "-t", "1"])
    assert exit_code == 0
    # When stdout is not a TTY, the CLI should pass show_progress_bar=False.
    assert used_settings and used_settings[0] is False


def test_main_version_flag_prints_and_exits(capsys: pytest.CaptureFixture[str]):
    """``--version`` should print the version and exit with code 0."""
    with pytest.raises(SystemExit) as exit_info:
        main(["--version"])
    assert exit_info.value.code == 0
    captured = capsys.readouterr()
    assert "pictowebp" in captured.out
    # The version string should contain at least one digit.
    assert any(ch.isdigit() for ch in captured.out)


def test_main_lossless_skips_quality_prompt(tmp_path: Path, monkeypatch):
    """``--lossless`` must never prompt for quality (it is ignored)."""

    def fail_input(_prompt: str = "") -> str:
        raise AssertionError("quality prompt should not appear with --lossless")

    monkeypatch.setattr("builtins.input", fail_input)

    source = tmp_path / "pics"
    source.mkdir()
    Image.new("RGB", (16, 16), (10, 200, 30)).save(source / "img.png")

    assert main([str(source), "--lossless", "-t", "1", "--no-progress"]) == 0


def test_main_keyboard_interrupt_returns_130(tmp_path: Path, monkeypatch):
    """A hard interrupt (second Ctrl+C) exits cleanly with code 130."""
    from pictowebp import converter as converter_module

    source = tmp_path / "pics"
    source.mkdir()
    Image.new("RGB", (16, 16), (10, 200, 30)).save(source / "img.png")

    def raise_interrupt(*_args, **_kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr("pictowebp.cli.convert_folder", raise_interrupt)
    assert main([str(source), "-q", "80", "-t", "1", "--no-progress"]) == 130
    assert converter_module is not None


def test_main_expanduser_on_cli_path(tmp_path: Path, monkeypatch):
    """``~`` in the CLI path expands to the user's home directory."""
    import os

    fake_home = tmp_path / "home"
    source = fake_home / "pics"
    source.mkdir(parents=True)
    Image.new("RGB", (16, 16), (10, 200, 30)).save(source / "img.png")

    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("USERPROFILE", str(fake_home))
    monkeypatch.setattr(Path, "home", classmethod(lambda _cls: fake_home))

    exit_code = main(["~/pics", "-q", "80", "-t", "1", "--no-progress"])
    assert exit_code == 0
    assert os.path.isdir(fake_home / "pics")


def test_format_duration_helper():
    from pictowebp.cli import _format_duration

    assert _format_duration(7.24) == "7.2s"
    assert _format_duration(46.11) == "46.1s"
    assert _format_duration(65.0) == "1m 05s"
    assert _format_duration(186.0) == "3m 06s"

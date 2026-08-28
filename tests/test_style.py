"""Tests for the shared ANSI styling helpers."""

from pictowebp.style import (
    BOLD_CYAN,
    CYAN,
    DIM,
    GREEN,
    LINE,
    RED,
    YELLOW,
    field,
    paint,
    section,
    supports_color,
    truncate_reason,
)


def test_paint_returns_plain_text_when_no_color(monkeypatch, capsys):
    monkeypatch.delenv("NO_COLOR", raising=False)
    monkeypatch.setattr("sys.stdout.isatty", lambda: False)
    assert paint("hello", CYAN) == "hello"
    assert paint("hello", DIM) == "hello"


def test_paint_applies_ansi_when_terminal(monkeypatch):
    monkeypatch.delenv("NO_COLOR", raising=False)
    monkeypatch.setattr("sys.stdout.isatty", lambda: True)
    output = paint("hello", CYAN)
    assert output.startswith("\x1b[")
    assert output.endswith("\x1b[0m")
    assert "hello" in output


def test_paint_respects_no_color_env(monkeypatch):
    monkeypatch.setenv("NO_COLOR", "1")
    monkeypatch.setattr("sys.stdout.isatty", lambda: True)
    assert paint("hello", CYAN) == "hello"
    assert not supports_color()


def test_section_prints_separator_lines(capsys):
    section("Title", BOLD_CYAN)
    captured = capsys.readouterr()
    assert LINE in captured.out
    assert "Title" in captured.out


def test_field_prints_label_and_value(capsys):
    field("Source:", "/some/path")
    captured = capsys.readouterr()
    assert "Source:" in captured.out
    assert "/some/path" in captured.out


def test_truncate_reason_short_passthrough():
    assert truncate_reason("short error") == "short error"


def test_truncate_reason_long_is_truncated():
    long = "x" * 1000
    truncated = truncate_reason(long)
    assert len(truncated) < 1000
    assert truncated.endswith("…")


def test_color_constants_are_unique():
    constants = {BOLD_CYAN, CYAN, DIM, GREEN, YELLOW, RED}
    assert len(constants) == 6

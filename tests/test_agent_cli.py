"""Tests for the agent-facing CLI contract (``--json``, ``--info`` and friends)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from pictowebp.cli import build_parser, main
from pictowebp.output import set_json_mode


@pytest.fixture(autouse=True)
def _reset_json_mode():
    yield
    set_json_mode(False)


def _make_source(tmp_path: Path) -> Path:
    source = tmp_path / "pics"
    source.mkdir()
    Image.new("RGB", (16, 16), (10, 200, 30)).save(source / "good.png")
    (source / "broken.png").write_bytes(b"not an image")
    return source


def _only_object(stdout: str) -> dict:
    assert stdout.strip().count("\n") == 0, "stdout must hold exactly one JSON object"
    return json.loads(stdout)


def test_parser_accepts_agent_flags(tmp_path: Path):
    args = build_parser().parse_args(
        [
            str(tmp_path),
            "--json",
            "--yes",
            "--out",
            str(tmp_path / "dest"),
            "--dry-run",
            "--fail-on-error",
            "--fail-on-empty",
            "--max-pixels",
            "1000000",
        ]
    )
    assert args.json is True
    assert args.yes is True
    assert args.out == tmp_path / "dest"
    assert args.dry_run is True
    assert args.fail_on_error is True
    assert args.fail_on_empty is True
    assert args.max_pixels == 1_000_000


def test_json_result_is_a_single_object(tmp_path: Path, capsys):
    source = _make_source(tmp_path)

    code = main([str(source), "--json"])

    captured = capsys.readouterr()
    assert code == 0
    payload = _only_object(captured.out)
    assert payload["schema"] == "pictowebp.result/v1"
    assert payload["tool"]["edition"] == "python"
    assert payload["counts"] == {
        "discovered": 2,
        "converted": 1,
        "failed": 1,
        "collisions": 0,
    }
    assert payload["ok"] is False
    assert Path(payload["output"]).is_dir()
    assert payload["failures"][0]["category"] == "Corrupt or mislabeled image"


def test_json_keeps_human_output_on_stderr(tmp_path: Path, capsys):
    source = _make_source(tmp_path)

    main([str(source), "--json"])

    captured = capsys.readouterr()
    assert "Configuration" in captured.err
    assert "Configuration" not in captured.out


def test_info_json_reports_capabilities(tmp_path: Path, capsys):
    code = main(["--info", "--json"])

    captured = capsys.readouterr()
    assert code == 0
    payload = _only_object(captured.out)
    assert payload["schema"] == "pictowebp.info/v1"
    assert payload["edition"] == "python"
    assert "json" in payload["capabilities"]
    assert "dry_run" in payload["capabilities"]


def test_version_reports_the_edition(capsys):
    with pytest.raises(SystemExit) as excinfo:
        main(["--version"])
    assert excinfo.value.code == 0
    assert "(python)" in capsys.readouterr().out


def test_non_interactive_run_uses_defaults(tmp_path: Path):
    """No -q/-t and no terminal must not prompt or hang."""
    source = _make_source(tmp_path)

    assert main([str(source), "--no-progress"]) == 0


def test_dry_run_writes_nothing(tmp_path: Path, capsys):
    source = _make_source(tmp_path)

    code = main([str(source), "--dry-run", "--json"])

    captured = capsys.readouterr()
    assert code == 0
    payload = _only_object(captured.out)
    assert payload["dry_run"] is True
    assert payload["output"] is None
    assert payload["counts"]["converted"] == 2
    assert not list(tmp_path.glob("pics_webp_*"))


def test_single_file_converts_and_refuses_overwrite(tmp_path: Path, capsys):
    source = _make_source(tmp_path)
    image = source / "good.png"

    assert main([str(image), "--json"]) == 0
    assert (source / "good.webp").is_file()
    capsys.readouterr()

    assert main([str(image), "--json"]) == 3
    payload = _only_object(capsys.readouterr().out)
    assert payload["counts"]["failed"] == 1
    assert payload["failures"][0]["category"] == "Output file already exists"


def test_out_dir_is_used(tmp_path: Path, capsys):
    source = _make_source(tmp_path)
    destination = tmp_path / "dest"

    assert main([str(source), "--out", str(destination), "--json"]) == 0

    payload = _only_object(capsys.readouterr().out)
    assert payload["output"] == str(destination)
    assert (destination / "good.webp").is_file()


def test_out_dir_inside_source_is_rejected(tmp_path: Path, capsys):
    source = _make_source(tmp_path)

    assert main([str(source), "--out", str(source / "dest"), "--json"]) == 2
    payload = _only_object(capsys.readouterr().out)
    assert payload["schema"] == "pictowebp.error/v1"


def test_fail_on_error_and_fail_on_empty(tmp_path: Path):
    source = _make_source(tmp_path)
    assert main([str(source), "--fail-on-error", "--json"]) == 4

    empty = tmp_path / "empty"
    empty.mkdir()
    assert main([str(empty), "--fail-on-empty", "--json"]) == 5


def test_empty_folder_creates_no_output(tmp_path: Path):
    empty = tmp_path / "empty"
    empty.mkdir()

    assert main([str(empty), "--json"]) == 0
    assert not list(tmp_path.glob("empty_webp_*"))


CONTRACT_FLAGS = (
    "--json",
    "--info",
    "--yes",
    "--interactive",
    "--out",
    "--dry-run",
    "--fail-on-error",
    "--fail-on-empty",
    "--allow-report-outside",
    "--max-pixels",
)


def test_help_advertises_the_contract_flags(capsys):
    with pytest.raises(SystemExit) as excinfo:
        main(["--help"])
    assert excinfo.value.code == 0
    help_text = capsys.readouterr().out
    for flag in CONTRACT_FLAGS:
        assert flag in help_text, f"{flag} missing from --help"


def test_single_file_with_a_bare_relative_name(tmp_path: Path, monkeypatch, capsys):
    """`pictowebp photo.png` must work from the file's own directory."""
    source = _make_source(tmp_path)
    monkeypatch.chdir(source)

    assert main(["good.png", "--json"]) == 0

    payload = _only_object(capsys.readouterr().out)
    assert payload["counts"]["converted"] == 1
    assert (source / "good.webp").is_file()


def test_dry_run_reports_existing_single_output(tmp_path: Path, capsys):
    source = _make_source(tmp_path)
    image = source / "good.png"
    assert main([str(image), "--json"]) == 0
    capsys.readouterr()

    assert main([str(image), "--json", "--dry-run"]) == 0

    payload = _only_object(capsys.readouterr().out)
    assert payload["dry_run"] is True
    assert payload["counts"]["converted"] == 0
    assert payload["counts"]["failed"] == 1
    assert payload["failures"][0]["category"] == "Output file already exists"


def test_dry_run_with_only_collisions_exits_zero(tmp_path: Path, capsys):
    source = tmp_path / "dups"
    source.mkdir()
    Image.new("RGB", (8, 8), (1, 2, 3)).save(source / "dup.png")
    Image.new("RGB", (8, 8), (1, 2, 3)).save(source / "dup.jpg")

    assert main([str(source), "--json", "--dry-run"]) == 0

    payload = _only_object(capsys.readouterr().out)
    assert payload["counts"]["converted"] == 0
    assert payload["counts"]["collisions"] == 2


def test_invalid_arguments_emit_json(capsys):
    with pytest.raises(SystemExit) as excinfo:
        main(["--json", "-q", "0"])

    assert excinfo.value.code == 2
    payload = _only_object(capsys.readouterr().out)
    assert payload["schema"] == "pictowebp.error/v1"


def test_empty_source_with_out_creates_no_directory(tmp_path: Path):
    empty = tmp_path / "empty"
    empty.mkdir()
    destination = tmp_path / "dest"

    assert main([str(empty), "--json", "--out", str(destination)]) == 0
    assert not destination.exists()


def test_report_outside_requires_flag(tmp_path: Path, capsys):
    source = _make_source(tmp_path)
    outside = tmp_path / "errors.txt"

    assert main([str(source), "--json", "--report", str(outside)]) == 2
    payload = _only_object(capsys.readouterr().out)
    assert payload["schema"] == "pictowebp.error/v1"
    assert not outside.exists()
    assert not list(tmp_path.glob("pics_webp_*")), "rejected run left an output folder behind"

    assert (
        main(
            [
                str(source),
                "--json",
                "--report",
                str(outside),
                "--allow-report-outside",
            ]
        )
        == 0
    )
    assert outside.is_file()

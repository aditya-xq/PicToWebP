"""Validate the shipped JSON Schemas against real CLI payloads."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import jsonschema

from pictowebp.report import build_info, error_payload

SCHEMAS = Path(__file__).resolve().parents[1] / "agent" / "pictowebp" / "schemas"
CATALOG = Path(__file__).resolve().parents[1] / "agent" / "index.json"


def _schema(name: str) -> dict:
    return json.loads((SCHEMAS / name).read_text(encoding="utf-8"))


def _validate(name: str, payload: dict) -> None:
    jsonschema.validate(instance=payload, schema=_schema(name))


def test_info_payload_matches_schema():
    _validate("info-v1.json", build_info())


def test_error_payload_matches_schema():
    _validate("error-v1.json", error_payload("source path does not exist"))
    _validate(
        "error-v1.json",
        {**error_payload("source path does not exist"), "ok": False},
    )


def test_cli_result_matches_schema(tmp_path: Path, source_dir: Path, image_factory):
    image_factory("good.png")
    (source_dir / "broken.png").write_bytes(b"not an image")

    proc = subprocess.run(
        [sys.executable, "-m", "pictowebp", str(source_dir), "--json"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["counts"]["failed"] == 1
    _validate("result-v1.json", payload)


def test_cli_dry_run_result_matches_schema(tmp_path: Path, source_dir: Path, image_factory):
    image_factory("good.png")

    proc = subprocess.run(
        [sys.executable, "-m", "pictowebp", str(source_dir), "--json", "--dry-run"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["output"] is None
    _validate("result-v1.json", payload)


def test_installer_payloads_match_schema():
    digest = "a" * 64
    _validate(
        "install-v1.json",
        {
            "schema": "pictowebp.install/v1",
            "action": "install",
            "version": "0.4.0",
            "target": "x86_64-unknown-linux-musl",
            "path": "/tmp/pictowebp",
            "sha256": digest,
            "on_path": False,
            "verified": True,
            "dry_run": False,
        },
    )
    _validate(
        "install-v1.json",
        {
            "schema": "pictowebp.install/v1",
            "version": "0.4.0",
            "target": "x86_64-unknown-linux-musl",
            "sha256": digest,
            "verified": True,
            "path": "/tmp/pictowebp",
            "installed": "2026-11-12",
        },
    )
    _validate(
        "install-v1.json",
        {
            "schema": "pictowebp.install/v1",
            "error": "SHA-256 mismatch",
        },
    )


def test_release_manifest_matches_schema():
    _validate(
        "release-v1.json",
        {
            "schema": "pictowebp.release/v1",
            "version": "0.4.0",
            "assets": {
                "x86_64-unknown-linux-musl": {
                    "url": (
                        "https://github.com/aditya-xq/PicToWebP/releases/download/"
                        "rust-v0.4.0/pictowebp-0.4.0-x86_64-unknown-linux-musl.tar.gz"
                    ),
                    "sha256": "b" * 64,
                }
            },
        },
    )


def test_catalog_ships_every_schema():
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    files = set(catalog["skills"][0]["files"])
    schemas = {f"schemas/{path.name}" for path in SCHEMAS.glob("*.json")}
    assert schemas
    assert schemas <= files


def test_schema_index_lists_every_schema():
    index = json.loads((SCHEMAS / "index.json").read_text(encoding="utf-8"))
    listed = set(index["schemas"].values())
    actual = {path.name for path in SCHEMAS.glob("*-v1.json")}
    assert listed == actual

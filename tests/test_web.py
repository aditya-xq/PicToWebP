"""Tests for the FastAPI application."""

import json
from pathlib import Path
from threading import Lock

import pytest
from fastapi.testclient import TestClient

from pictowebp.progress import TERMINAL_STATUSES
from pictowebp.web.app import create_app


@pytest.fixture()
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def populated_source(image_factory, source_dir: Path) -> Path:
    image_factory("photo.png")
    return source_dir


def test_index_serves_ui(client: TestClient):
    response = client.get("/")
    assert response.status_code == 200
    assert "PicToWebP" in response.text
    assert response.headers["content-type"].startswith("text/html")


def test_favicon_is_served(client: TestClient):
    response = client.get("/favicon.ico")
    assert response.status_code == 200


def test_convert_validates_payload(client: TestClient):
    response = client.post("/convert", json={})
    assert response.status_code == 422


def test_convert_rejects_unknown_folder(client: TestClient):
    response = client.post("/convert", json={"source_folder": str(Path("Z:/definitely/missing"))})
    assert response.status_code == 400


def test_convert_runs_to_completion(client: TestClient, populated_source: Path):
    response = client.post("/convert", json={"source_folder": str(populated_source), "threads": 2})
    assert response.status_code == 202

    snapshot = client.get("/api/status").json()
    assert snapshot["status"] == "completed"
    assert snapshot["converted_files"] == 1
    assert snapshot["total_files"] == 1
    assert snapshot["original_bytes"] > 0


def test_convert_rejects_concurrent_jobs(client: TestClient, populated_source: Path):
    lock: Lock = client.app.state.conversion_lock  # type: ignore[attr-defined]
    with lock:
        response = client.post("/convert", json={"source_folder": str(populated_source)})
    assert response.status_code == 429


def test_cancel_returns_400_when_idle(client: TestClient):
    response = client.post("/convert/cancel")
    assert response.status_code == 400
    assert "No conversion" in response.json()["detail"]


def test_cancel_requests_cooperative_cancellation(client: TestClient, monkeypatch):
    """The cancel endpoint must ask the converter to stop, not fake the status."""
    import pictowebp.web.app as web_app

    called: list[bool] = []
    monkeypatch.setattr(web_app, "request_cancellation", lambda: called.append(True) or True)

    client.app.state.progress.start(total_files=1)  # type: ignore[attr-defined]
    response = client.post("/convert/cancel")

    assert response.status_code == 200
    assert called == [True]
    # The endpoint must not touch the tracker directly; the conversion loop
    # owns the terminal status.
    assert client.app.state.progress.status == "running"  # type: ignore[attr-defined]


def test_validate_matches_conversion_discovery(client: TestClient, image_factory, source_dir: Path):
    """Images inside hidden directories are never converted, so don't count them."""
    image_factory("visible.png")
    hidden = source_dir / ".hidden"
    hidden.mkdir()
    image_factory(".hidden/secret.png")

    response = client.post("/api/validate", json={"source_folder": str(source_dir)})
    data = response.json()

    assert data["valid"] is True
    assert data["total_files"] == 1
    assert data["total_size_bytes"] > 0


def test_progress_stream_emits_terminal_snapshot(client: TestClient, populated_source: Path):
    # Complete a conversion first so the SSE stream terminates on its own.
    client.post("/convert", json={"source_folder": str(populated_source), "threads": 2})

    with client.stream("GET", "/progress") as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        final_event: dict | None = None
        for chunk in response.iter_text():
            assert chunk.startswith("data: ")
            final_event = json.loads(chunk.removeprefix("data: "))
            if final_event["status"] in TERMINAL_STATUSES:
                break

    assert final_event is not None
    assert final_event["status"] == "completed"
    assert final_event["converted_files"] == 1

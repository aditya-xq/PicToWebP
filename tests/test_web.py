"""Tests for the FastAPI application."""

import json
import re
from collections.abc import Iterator
from pathlib import Path
from threading import Lock

import pytest
from fastapi.testclient import TestClient

import pictowebp.web.app as web_app_module
from pictowebp.progress import TERMINAL_STATUSES
from pictowebp.web.app import create_app

# Built by `npm run build:python` in web-ts/. The API tests below never need
# it; only the SPA-serving tests do.
SPA_INDEX = Path(__file__).resolve().parents[1] / "web-ts" / "dist-python" / "index.html"


@pytest.fixture()
def client() -> Iterator[TestClient]:
    app = create_app()
    # The API only answers loopback Host headers (drive-by/rebinding guard),
    # so the test client must present one too (default is "testserver").
    with TestClient(app, base_url="http://127.0.0.1") as test_client:
        yield test_client


@pytest.fixture()
def populated_source(image_factory, source_dir: Path) -> Path:
    image_factory("photo.png")
    return source_dir


@pytest.mark.skipif(
    not SPA_INDEX.is_file(), reason="web UI not built; run `npm run build:python` in web-ts"
)
def test_index_serves_built_spa(client: TestClient):
    """The unified SPA is served at / when the python build exists."""
    response = client.get("/")
    assert response.status_code == 200
    assert "PicToWebP" in response.text
    assert "Content-Security-Policy" in response.text
    # No external *assets* — the UI must work fully offline. Scan every
    # src/href for a scheme-qualified URL: anything external must be the
    # single outbound author hyperlink (user-initiated navigation, never
    # fetched by the page). The real no-network guarantee is enforced at
    # runtime by the strict CSP and the e2e smoke suite.
    external = sorted(
        url
        for url in re.findall(r'\b(?:src|href)=["\']([^"\']+)["\']', response.text)
        if url.startswith(("http://", "https://"))
    )
    assert external == ["https://x.com/xq_is_here"], external


def test_index_returns_setup_help_without_build(client: TestClient):
    """Without a built SPA the root still answers (503 with a helpful note)."""
    if SPA_INDEX.is_file():
        pytest.skip("web UI is built; this fallback path is not exercised")
    response = client.get("/")
    assert response.status_code == 503
    assert "not built" in response.text


def test_convert_validates_payload(client: TestClient):
    response = client.post("/convert", json={})
    assert response.status_code == 422


def test_rejects_foreign_host_header(client: TestClient):
    """A non-loopback Host means a rebinding/drive-by attempt — refuse it."""
    response = client.get("/api/status", headers={"Host": "evil.example.com"})
    assert response.status_code == 403


def test_rejects_foreign_origin(client: TestClient):
    """A page on another origin must not be able to drive the local API."""
    response = client.get("/api/status", headers={"Origin": "https://evil.example.com"})
    assert response.status_code == 403


def test_accepts_same_origin_request(client: TestClient):
    """Loopback Host + matching same-origin Origin header passes the guard."""
    response = client.get("/api/status", headers={"Origin": "http://127.0.0.1"})
    assert response.status_code == 200


def test_trusted_hosts_env_allows_lan_access(monkeypatch: pytest.MonkeyPatch):
    """PICTOWEBP_TRUSTED_HOSTS opts a LAN hostname into the Host guard."""
    monkeypatch.setenv("PICTOWEBP_TRUSTED_HOSTS", "my-nas.local")
    app = create_app()
    with TestClient(app, base_url="http://my-nas.local") as lan_client:
        assert lan_client.get("/api/status").status_code == 200
    with TestClient(app, base_url="http://127.0.0.1") as loopback_client:
        assert loopback_client.get("/api/status").status_code == 200


def test_convert_single_rejects_oversized_upload(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """The Content-Length pre-check must refuse huge uploads before spooling."""
    monkeypatch.setattr(web_app_module, "MAX_UPLOAD_BYTES", 8)
    response = client.post(
        "/api/convert-single",
        files={"file": ("big.png", b"1234567890", "image/png")},
    )
    assert response.status_code == 413


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
            event = json.loads(chunk.removeprefix("data: "))
            if event["status"] in TERMINAL_STATUSES:
                final_event = event
                break

    assert final_event is not None
    assert final_event["status"] == "completed"
    assert final_event["converted_files"] == 1


def test_download_zip_requires_completed_conversion(client: TestClient):
    response = client.get("/api/download-zip")
    assert response.status_code == 404


def test_download_zip_returns_output_archive(client: TestClient, populated_source: Path):
    import io
    import zipfile

    client.post("/convert", json={"source_folder": str(populated_source), "threads": 2})
    response = client.get("/api/download-zip")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/zip")
    assert "attachment" in response.headers["content-disposition"]

    with zipfile.ZipFile(io.BytesIO(response.content)) as zf:
        names = zf.namelist()
    assert len(names) == 1
    assert names[0].endswith(".webp")


def test_convert_single_runs_off_event_loop(client: TestClient, image_factory, source_dir: Path):
    """Large single conversions must not block the event loop (SSE stays live)."""
    image_factory("solo.png")
    png = source_dir / "solo.png"
    response = client.post(
        "/api/convert-single",
        files={"file": ("solo.png", png.read_bytes(), "image/png")},
        data={"quality": "80"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/webp")

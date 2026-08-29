"""FastAPI application exposing the converter over HTTP.

Endpoints:
    GET  /              - web UI (single-page)
    POST /convert       - start a conversion job (202 Accepted)
    GET  /progress      - server-sent events with live progress snapshots
    GET  /api/status    - one-shot JSON snapshot of the current progress
    POST /api/validate  - validate a source folder
    POST /api/browse    - list directories at a path
    GET  /api/history   - conversion history
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from importlib import resources
from pathlib import Path
from threading import Lock

import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from PIL import Image

from pictowebp import __version__
from pictowebp.console import force_utf8_stdio
from pictowebp.converter import convert_folder, request_cancellation
from pictowebp.logging_setup import setup_logging
from pictowebp.progress import TERMINAL_STATUSES, ConversionProgress
from pictowebp.utils import get_folder_info
from pictowebp.web.schemas import ConvertRequest, ValidateRequest

logger = logging.getLogger(__name__)

TEMPLATES_DIR = resources.files("pictowebp") / "templates"
PROGRESS_POLL_SECONDS = 0.2

# The tool is designed for local use; browsers only need read-only cross-origin access.
CORS_ALLOW_ORIGINS = ["*"]

MAX_HISTORY = 50


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    setup_logging()
    logger.info("PicToWebP %s ready", __version__)
    yield


def create_app() -> FastAPI:
    """Build a fully wired application instance (fresh state per app)."""
    app = FastAPI(title="PicToWebP API", version=__version__, lifespan=_lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ALLOW_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    progress = ConversionProgress()
    # A non-reentrant guard so only one conversion runs at a time.
    conversion_lock = Lock()
    conversion_history: list[dict] = []
    app.state.progress = progress
    app.state.conversion_lock = conversion_lock

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(TEMPLATES_DIR / "index.html", media_type="text/html")

    @app.get("/static/ui.css", include_in_schema=False)
    def ui_css() -> FileResponse:
        """Shared design system — the same stylesheet the browser edition bundles."""
        return FileResponse(TEMPLATES_DIR / "ui.css", media_type="text/css")

    @app.get("/favicon.ico", include_in_schema=False)
    def favicon() -> FileResponse:
        return FileResponse(TEMPLATES_DIR / "favicon.ico")

    @app.post("/convert", status_code=status.HTTP_202_ACCEPTED)
    def start_conversion(payload: ConvertRequest, background_tasks: BackgroundTasks) -> dict:
        source_folder = Path(payload.source_folder)
        if not source_folder.is_dir():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Source folder does not exist or is not a directory",
            )
        if not conversion_lock.acquire(blocking=False):
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="A conversion is already in progress",
            )

        progress.set_source_folder(str(source_folder))

        def run_job() -> None:
            job_id = str(uuid.uuid4())[:8]
            try:
                result = convert_folder(
                    source_folder,
                    quality=payload.quality,
                    threads=payload.threads,
                    progress=progress,
                    show_progress_bar=False,
                    lossless=payload.lossless,
                    strip_metadata=payload.strip_metadata,
                    resize_width=payload.resize_width,
                    resize_height=payload.resize_height,
                )
                # Record in history
                snap = result.snapshot()
                history_entry = {
                    "id": job_id,
                    "source_folder": str(source_folder),
                    "output_folder": snap.get("output_folder", ""),
                    "output_format": "WEBP",
                    "quality": payload.quality,
                    "total_files": snap["total_files"],
                    "converted_files": snap["converted_files"],
                    "failed_files": snap["failed_files"],
                    "bytes_saved": snap["bytes_saved"],
                    "reduction_percent": snap["reduction_percent"],
                    "elapsed_seconds": snap["elapsed_seconds"],
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                conversion_history.append(history_entry)
                if len(conversion_history) > MAX_HISTORY:
                    conversion_history.pop(0)
            except Exception:
                logger.exception("Conversion of %s failed", source_folder)
                if progress.status not in TERMINAL_STATUSES:
                    progress.finish("failed", elapsed_seconds=0.0, error="unexpected server error")
            finally:
                conversion_lock.release()

        background_tasks.add_task(run_job)
        return {"message": "Conversion started", **progress.snapshot()}

    @app.post("/convert/cancel", status_code=status.HTTP_200_OK)
    def cancel_conversion() -> dict:
        """Request cooperative cancellation of the current conversion.

        The conversion loop stops submitting new work and finishes the
        in-flight files; the background job itself moves the tracker to the
        ``cancelled`` status when it winds down.
        """
        if progress.status == "running" and request_cancellation():
            return {"message": "Cancellation requested"}
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No conversion is currently running",
        )

    @app.get("/progress")
    async def progress_events(request: Request) -> StreamingResponse:
        """Stream live progress snapshots as server-sent events."""

        async def events() -> AsyncIterator[str]:
            # Wait briefly for the conversion to actually start, so we
            # don't emit a stale "completed" status from a previous run.
            for _ in range(20):
                snapshot = progress.snapshot()
                if snapshot["status"] == "running":
                    break
                await asyncio.sleep(0.05)
            else:
                snapshot = progress.snapshot()

            yield f"data: {json.dumps(snapshot)}\n\n"
            if snapshot["status"] in TERMINAL_STATUSES:
                return

            while True:
                await asyncio.sleep(PROGRESS_POLL_SECONDS)
                snapshot = progress.snapshot()
                yield f"data: {json.dumps(snapshot)}\n\n"
                if snapshot["status"] in TERMINAL_STATUSES:
                    break
                if await request.is_disconnected():
                    break

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/api/status")
    def api_status() -> dict:
        return progress.snapshot()

    @app.post("/api/validate")
    def validate_folder(payload: ValidateRequest) -> dict:
        """Validate a source folder and return info about convertible images."""
        folder = Path(payload.source_folder)
        if not folder.is_dir():
            return {
                "valid": False,
                "error": "Folder does not exist or is not a directory",
                "total_files": 0,
                "format_counts": {},
                "total_size_bytes": 0,
                "total_size_display": "0 B",
            }
        info = get_folder_info(folder)
        if not info["valid"]:
            return {
                "valid": False,
                "error": "No convertible images found in this folder",
                "total_files": 0,
                "format_counts": {},
                "total_size_bytes": 0,
                "total_size_display": "0 B",
            }
        return info

    @app.post("/api/browse")
    def browse_directory(payload: ValidateRequest) -> dict:
        """List subdirectories at the given path for the file browser."""
        raw = payload.source_folder.strip() if payload.source_folder else ""
        if not raw:
            # On Windows list drive roots, elsewhere use /
            import sys

            if sys.platform == "win32":
                import string

                drives = [f"{d}:\\" for d in string.ascii_uppercase if Path(f"{d}:\\").exists()]
                return {"current": "This PC", "parent": None, "drives": drives, "entries": []}
            raw = "/"

        path = Path(raw)
        if not path.exists():
            path = path.parent
        if not path.is_dir():
            import sys

            if sys.platform == "win32":
                path = Path(path.anchor) if path.anchor else Path("C:\\")
            else:
                path = Path("/")

        try:
            entries = sorted(
                [
                    {"name": p.name, "path": str(p), "is_dir": p.is_dir()}
                    for p in path.iterdir()
                    if p.is_dir() and not p.name.startswith(".")
                ],
                key=lambda e: e["name"].lower(),
            )
        except PermissionError:
            entries = []

        parent = str(path.parent) if path.parent != path else None
        return {
            "current": str(path),
            "parent": parent,
            "entries": entries,
        }

    @app.get("/api/history")
    def get_history() -> dict:
        """Return conversion history (newest first)."""
        return {"history": list(reversed(conversion_history))}

    @app.delete("/api/history")
    def clear_history() -> dict:
        """Clear conversion history."""
        conversion_history.clear()
        return {"message": "History cleared"}

    @app.post("/api/open-folder")
    def open_folder(payload: ValidateRequest) -> dict:
        """Open a folder in the OS file explorer."""
        import platform
        import subprocess

        folder = Path(payload.source_folder)
        if not folder.is_dir():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Folder does not exist",
            )
        try:
            system = platform.system()
            if system == "Windows":
                import os

                os.startfile(str(folder))  # type: ignore[attr-defined]
            elif system == "Darwin":
                subprocess.Popen(["open", str(folder)])
            else:
                subprocess.Popen(["xdg-open", str(folder)])
        except Exception:
            logger.exception("Failed to open folder %s", folder)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to open folder",
            ) from None
        return {"message": "Opened folder"}

    @app.post("/api/convert-single")
    async def convert_single_image(
        file: UploadFile = File(...),  # noqa: B008
        quality: int = 80,
        lossless: bool = False,
        strip_metadata: bool = True,
        resize_width: int | None = None,
        resize_height: int | None = None,
    ) -> Response:
        """Convert a single uploaded image to WebP and return it for download."""
        if not file.content_type or not file.content_type.startswith("image/"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Uploaded file is not an image",
            )
        try:
            contents = await file.read()
            img = Image.open(io.BytesIO(contents))
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Could not read the uploaded image",
            ) from None

        # Prepare image
        from pictowebp.utils import _prepare_image

        prepared = _prepare_image(
            img,
            resize_width=resize_width,
            resize_height=resize_height,
        )

        # Save to in-memory buffer
        buf = io.BytesIO()
        save_kwargs: dict = {
            "format": "WEBP",
            "quality": quality,
            "lossless": lossless,
        }
        if not strip_metadata:
            if exif := img.info.get("exif"):
                save_kwargs["exif"] = exif
            if icc := img.info.get("icc_profile"):
                save_kwargs["icc_profile"] = icc
        prepared.save(buf, **save_kwargs)
        buf.seek(0)

        # Build download filename
        stem = Path(file.filename).stem if file.filename else "image"
        download_name = f"{stem}.webp"

        return Response(
            content=buf.read(),
            media_type="image/webp",
            headers={
                "Content-Disposition": f'attachment; filename="{download_name}"',
            },
        )

    return app


app = create_app()


def main(argv: list[str] | None = None) -> None:
    """Entry point for the ``pictowebp-web`` console script."""
    force_utf8_stdio()
    parser = argparse.ArgumentParser(prog="pictowebp-web", description="PicToWebP web UI")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: %(default)s)")
    parser.add_argument("--port", type=int, default=8000, help="port (default: %(default)s)")
    args = parser.parse_args(argv)

    setup_logging()
    uvicorn.run("pictowebp.web.app:app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()

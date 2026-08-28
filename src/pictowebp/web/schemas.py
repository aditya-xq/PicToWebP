"""Request schemas for the web API."""

from typing import Annotated

from pydantic import BaseModel, Field

from pictowebp.constants import (
    DEFAULT_QUALITY,
    MAX_QUALITY,
    MAX_RESIZE_HEIGHT,
    MAX_RESIZE_WIDTH,
    MAX_THREADS,
    MIN_QUALITY,
    MIN_RESIZE_HEIGHT,
    MIN_RESIZE_WIDTH,
)


class ConvertRequest(BaseModel):
    """Payload accepted by ``POST /convert``."""

    source_folder: Annotated[str, Field(min_length=1, description="Path to the folder to convert")]
    quality: Annotated[int, Field(ge=MIN_QUALITY, le=MAX_QUALITY)] = DEFAULT_QUALITY
    threads: Annotated[int | None, Field(ge=1, le=MAX_THREADS)] = None
    lossless: bool = False
    strip_metadata: bool = True
    resize_width: Annotated[int | None, Field(ge=MIN_RESIZE_WIDTH, le=MAX_RESIZE_WIDTH)] = None
    resize_height: Annotated[int | None, Field(ge=MIN_RESIZE_HEIGHT, le=MAX_RESIZE_HEIGHT)] = None


class ValidateRequest(BaseModel):
    """Payload accepted by ``POST /api/validate``."""

    source_folder: str


class ConversionHistoryItem(BaseModel):
    """A single entry in the conversion history."""

    id: str
    source_folder: str
    output_folder: str
    output_format: str
    quality: int
    total_files: int
    converted_files: int
    failed_files: int
    bytes_saved: int
    reduction_percent: float
    elapsed_seconds: float
    timestamp: str

"""Request schemas for the web API."""

from typing import Annotated

from pydantic import BaseModel, Field

from pictowebp.constants import (
    DEFAULT_QUALITY,
    MAX_QUALITY,
    MAX_THREADS,
    MIN_QUALITY,
)


class ConvertRequest(BaseModel):
    """Payload accepted by ``POST /convert``."""

    source_folder: Annotated[str, Field(min_length=1, description="Path to the folder to convert")]
    quality: Annotated[int, Field(ge=MIN_QUALITY, le=MAX_QUALITY)] = DEFAULT_QUALITY
    threads: Annotated[int | None, Field(ge=1, le=MAX_THREADS)] = None
    lossless: bool = False
    strip_metadata: bool = True


class ValidateRequest(BaseModel):
    """Payload accepted by ``POST /api/validate``."""

    source_folder: str

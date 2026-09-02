"""Image format definitions for input discovery and output conversion."""

from enum import Enum, unique


@unique
class InputImageFormat(str, Enum):
    """Image formats recognised as convertible input."""

    PNG = "png"
    JPEG = "jpeg"
    JPG = "jpg"
    WEBP = "webp"
    BMP = "bmp"
    TIFF = "tiff"
    GIF = "gif"


INPUT_SUFFIXES: frozenset[str] = frozenset(
    f".{image_format.value}" for image_format in InputImageFormat
)


@unique
class OutputImageFormat(str, Enum):
    """Formats that images can be converted to."""

    WEBP = "WEBP"

    @property
    def file_extension(self) -> str:
        """File extension (with leading dot) used for converted files."""
        return f".{self.value.lower()}"

    @property
    def pil_format(self) -> str:
        """Format identifier understood by Pillow when saving."""
        return self.value.upper()

"""PicToWebP: blazingly fast bulk image-to-WebP conversion."""

from pictowebp.converter import convert_folder
from pictowebp.enums import OutputImageFormat
from pictowebp.progress import ConversionProgress

__version__ = "1.0.0"

__all__ = [
    "ConversionProgress",
    "OutputImageFormat",
    "__version__",
    "convert_folder",
]

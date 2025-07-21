from enum import Enum

class OutputImageFormat(str, Enum):
    WEBP = 'WEBP'
    # add other formats as needed

class ImageFormat(Enum):
    """Enum representing supported image formats."""
    PNG = "png"
    JPEG = "jpeg"
    JPG = "jpg"
    WEBP = "webp"

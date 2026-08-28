"""Default configuration values and tunable constants."""

from __future__ import annotations

import os

MIN_QUALITY = 1
MAX_QUALITY = 100
DEFAULT_QUALITY = 80

DEFAULT_THREADS = os.cpu_count() or 4
MIN_THREADS = 1
MAX_THREADS = 256

# Number of jobs submitted to the process pool per drain cycle. A larger
# number keeps workers busier but increases memory pressure from pending futures.
CHUNK_SIZE = 64

# Bounds for explicit resize requests.
MIN_RESIZE_WIDTH = 16
MAX_RESIZE_WIDTH = 16384
MIN_RESIZE_HEIGHT = 16
MAX_RESIZE_HEIGHT = 16384

# Maximum length of an error reason shown in the terminal; longer messages
# are truncated with an ellipsis so a single bad file cannot blow up the
# column width.
MAX_REASON_DISPLAY_LENGTH = 240

# Threshold (in MiB) below which we warn that the output volume is low.
LOW_DISK_WARNING_MIB = 256

# Default name for the conversion error report inside the output folder.
ERROR_REPORT_NAME = "conversion-errors.txt"

"""Server-side vision-model transcription for raster-only PDF pages.

Split by responsibility: ``config`` resolves the endpoint from the
environment, ``render`` rasterizes a page to bounded JPEG, and ``transcribe``
makes the strictly validated chat-completions calls. This package re-exports
the original public surface so ``impromptu_ingestion.vision`` keeps every name.
"""

from impromptu_ingestion.vision.config import VisionConfig, vision_config
from impromptu_ingestion.vision.render import (
    PdfRect,
    RasterizablePage,
    VisionPixmap,
    render_vision_jpeg,
)
from impromptu_ingestion.vision.transcribe import (
    SYSTEM_PROMPT,
    TRANSCRIBE_INSTRUCTION,
    JsonOpener,
    TranscriptionJob,
    extract_vision_text,
    transcribe_jpeg,
    transcribe_pages,
)
from impromptu_ingestion.vision.transcribe import (
    line_elements as line_elements,
)

# Legacy underscore spelling pinned by the frozen test suite.
_line_elements = line_elements

__all__ = [
    "SYSTEM_PROMPT",
    "TRANSCRIBE_INSTRUCTION",
    "JsonOpener",
    "PdfRect",
    "RasterizablePage",
    "TranscriptionJob",
    "VisionConfig",
    "VisionPixmap",
    "_line_elements",
    "extract_vision_text",
    "render_vision_jpeg",
    "transcribe_jpeg",
    "transcribe_pages",
    "vision_config",
]

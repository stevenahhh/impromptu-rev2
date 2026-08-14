"""Structural deck adapters and their explicit rendering boundary."""

from impromptu_ingestion.adapters.base import (
    RenderingUnsupportedError,
    StructuralAdapter,
    StructuralExtractionError,
)
from impromptu_ingestion.adapters.pdf import PdfStructuralAdapter
from impromptu_ingestion.adapters.pptx import PptxStructuralAdapter

__all__ = [
    "PdfStructuralAdapter",
    "PptxStructuralAdapter",
    "RenderingUnsupportedError",
    "StructuralAdapter",
    "StructuralExtractionError",
]

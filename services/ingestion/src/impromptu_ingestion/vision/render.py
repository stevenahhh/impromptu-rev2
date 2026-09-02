"""Bounded page rasterization for the vision encoder."""

from typing import Protocol

import pymupdf

# ~300 DPI keeps small slide text legible for the vision encoder; JPEG keeps the
# request payload an order of magnitude smaller than PNG with no OCR-quality loss.
_VISION_DPI = 300
_MAX_EDGE = 4_096
_JPEG_QUALITY = 85


class PdfRect(Protocol):
    width: float
    height: float


class VisionPixmap(Protocol):
    def tobytes(self, output: str, **options: object) -> bytes: ...


class RasterizablePage(Protocol):
    """Minimal PyMuPDF page surface needed to rasterize for the model."""

    rect: PdfRect

    def get_pixmap(self, *, matrix: pymupdf.Matrix, alpha: bool) -> VisionPixmap: ...


def render_vision_jpeg(page: RasterizablePage) -> bytes | None:
    longest_points = max(page.rect.width, page.rect.height)
    if longest_points <= 0:
        return None
    zoom = min(_VISION_DPI / 72.0, _MAX_EDGE / longest_points)
    try:
        pixmap: VisionPixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        jpeg: bytes = pixmap.tobytes("jpg", jpg_quality=_JPEG_QUALITY)
    except Exception:
        # The rasterizer is a third-party surface; any failure there only means
        # this page falls back to local OCR, so it degrades instead of raising.
        return None
    if not jpeg:
        return None
    return jpeg

"""Deterministic static PDF page rendering without external converters.

Each validated PDF page is rasterized with PyMuPDF at a deterministic zoom
(targeting 192 DPI, capped at a 3840 px longest edge), encoded as a PNG, hashed,
and published under ``slides/``. PDF sources never carry animation timelines, so
every PDF render is static-only by construction.
"""

import hashlib
import json
from pathlib import Path
from typing import Protocol, cast

import pymupdf

from impromptu_ingestion.canonical import deck_id, slide_key
from impromptu_ingestion.render.contracts import RenderedDeck, RenderedSlide, RendererInfo
from impromptu_ingestion.render.source import RenderError

_PDF_SIGNATURE = b"%PDF-"
_MAX_PDF_PAGES = 500  # matches the default ingestion limit for PDF page counts
# PyMuPDF rasterizes at 72 DPI at zoom 1.0, which leaves a 960x540pt slide at a blurry
# 960x540 px on a 1080p audience screen. Render at 192 DPI (zoom 192/72) so a standard
# 16:9 slide lands at 2560x1440 px: supersampled and crisp on 1920x1080, near-native on
# 2560x1440 panels.
_RASTER_DPI = 192
# Longest-edge ceiling bounding raster memory and PNG size for oversized pages (e.g.
# poster-format PDFs): 4K covers the largest common display, and beyond it file size
# grows quadratically with no visible gain over an already-downsampled image.
_MAX_RASTER_PIXELS = 3_840


class _PdfRect(Protocol):
    width: float
    height: float


class _PdfPixmap(Protocol):
    def tobytes(self, output: str) -> bytes: ...


class _PdfPage(Protocol):
    rect: _PdfRect

    def get_pixmap(
        self, *, matrix: pymupdf.Matrix, alpha: bool, colorspace: pymupdf.Colorspace
    ) -> _PdfPixmap: ...


class _PdfDocument(Protocol):
    needs_pass: bool
    page_count: int

    def load_page(self, page_id: int) -> _PdfPage: ...

    def close(self) -> None: ...


def _require_empty_output(output_dir: Path) -> None:
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RenderError("output_directory_not_empty", f"{output_dir} already has contents")
    output_dir.mkdir(parents=True, exist_ok=True)


def _open_document(content: bytes) -> _PdfDocument:
    try:
        document = cast(_PdfDocument, pymupdf.open(stream=content, filetype="pdf"))
    except Exception as error:
        raise RenderError("invalid_pdf", "PDF document could not be parsed") from error
    if document.needs_pass:
        document.close()
        raise RenderError("encrypted_document", "encrypted PDFs are not supported")
    return document


def _zoom_for(page: _PdfPage) -> float:
    """Zoom matrix scale rendering the page at the target DPI, capped at the pixel ceiling."""
    longest = max(page.rect.width, page.rect.height)
    if longest <= 0:
        raise RenderError("invalid_page_size", "PDF page has no measurable size")
    return min(_RASTER_DPI / 72.0, _MAX_RASTER_PIXELS / longest)


def render_pdf_pages(source: Path, output_dir: Path) -> RenderedDeck:
    """Rasterize every page of one PDF and publish the static-only render artifacts."""
    if not source.is_file():
        raise RenderError("source_missing", f"{source} is not a file")
    _require_empty_output(output_dir)
    try:
        content = source.read_bytes()
    except OSError as error:
        raise RenderError("source_unreadable", f"{source} could not be read") from error
    if not content.startswith(_PDF_SIGNATURE):
        raise RenderError("source_not_a_pdf", "source is not a PDF document")

    source_sha256 = hashlib.sha256(content).hexdigest()
    document = _open_document(content)
    try:
        page_count = document.page_count
        if page_count <= 0:
            raise RenderError("empty_document", "PDF contains no pages")
        if page_count > _MAX_PDF_PAGES:
            raise RenderError("too_many_pages", f"PDF page count exceeds {_MAX_PDF_PAGES}")

        slides: list[RenderedSlide] = []
        payloads: list[tuple[str, bytes]] = []
        for index in range(page_count):
            page = document.load_page(index)
            zoom = _zoom_for(page)
            try:
                pixmap = page.get_pixmap(
                    matrix=pymupdf.Matrix(zoom, zoom), alpha=False, colorspace=pymupdf.csRGB
                )
                png = pixmap.tobytes("png")
            except Exception as error:
                raise RenderError(
                    "pdf_render_failed", f"page {index + 1} could not be rasterized"
                ) from error
            if not png:
                raise RenderError("pdf_render_failed", f"page {index + 1} produced no image")
            relative = f"slides/slide-{index + 1}.png"
            slides.append(
                RenderedSlide(
                    slide_key=slide_key(source_sha256, f"page:{index + 1}"),
                    source_index=index + 1,
                    relative_path=relative,
                    content_sha256=hashlib.sha256(png).hexdigest(),
                    width_points=round(page.rect.width, 4),
                    height_points=round(page.rect.height, 4),
                )
            )
            payloads.append((relative, png))
    finally:
        document.close()

    for relative, png in payloads:
        destination = output_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(png)

    rendered = RenderedDeck(
        deck_id=deck_id(source_sha256),
        renderer=RendererInfo(name="pymupdf", version=pymupdf.__version__),
        slides=tuple(slides),
        assets=(),
        fonts=(),
        timelines=(),
        mapping_issues=(),
        animation_eligible=False,
        ineligible_reason=(
            "static PDF rasterization: PDF pages render to fixed PNG images, so animation "
            "timelines and shape-level mapping cannot be produced"
        ),
    )
    (output_dir / "render.json").write_text(
        json.dumps(
            rendered.model_dump(mode="json"),
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return rendered

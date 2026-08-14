"""PyMuPDF positioned structural extraction without rendering or OCR."""

import hashlib
from typing import Protocol, TypedDict, cast

import pymupdf

from impromptu_ingestion.adapters.base import StructuralAdapter, StructuralExtractionError
from impromptu_ingestion.canonical import deck_id, slide_key
from impromptu_ingestion.contracts import (
    DeckManifest,
    ExtractionWarning,
    ImageElement,
    InputKind,
    RenderBoundary,
    SlideManifest,
    StructuralElement,
    TextElement,
    ValidatedInput,
)


class _PdfSpan(TypedDict):
    text: str
    bbox: tuple[float, float, float, float]


class _PdfLine(TypedDict):
    spans: list[_PdfSpan]


class _PdfBlock(TypedDict, total=False):
    type: int
    bbox: tuple[float, float, float, float]
    lines: list[_PdfLine]
    image: bytes
    ext: str
    width: int
    height: int


class _PdfTextPage(TypedDict):
    blocks: list[_PdfBlock]


class _PdfRect(Protocol):
    width: float
    height: float


class _PdfPage(Protocol):
    rect: _PdfRect

    def get_text(self, option: str, *, sort: bool) -> object: ...


class _PdfDocument(Protocol):
    needs_pass: bool
    page_count: int

    def load_page(self, page_id: int) -> pymupdf.Page: ...

    def close(self) -> None: ...


def _position(bbox: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = bbox
    return (
        round(max(0.0, x0), 4),
        round(max(0.0, y0), 4),
        round(max(0.0, x1 - x0), 4),
        round(max(0.0, y1 - y0), 4),
    )


def _text_elements(block: _PdfBlock, block_index: int) -> list[TextElement]:
    elements: list[TextElement] = []
    for line_index, line in enumerate(block.get("lines", []), start=1):
        for span_index, span in enumerate(line["spans"], start=1):
            text = span["text"].strip()
            if text:
                x, y, width, height = _position(span["bbox"])
                elements.append(
                    TextElement(
                        element_id=f"text:{block_index}:{line_index}:{span_index}",
                        text=text,
                        x=x,
                        y=y,
                        width=width,
                        height=height,
                    )
                )
    return elements


def _image_element(block: _PdfBlock, block_index: int) -> ImageElement | None:
    content = block.get("image")
    bbox = block.get("bbox")
    if not content or bbox is None:
        return None
    extension = block.get("ext", "unknown").lower()
    media_type = "image/jpeg" if extension in {"jpg", "jpeg"} else f"image/{extension}"
    x, y, width, height = _position(bbox)
    return ImageElement(
        element_id=f"image:{block_index}",
        content_sha256=hashlib.sha256(content).hexdigest(),
        media_type=media_type,
        pixel_width=block.get("width"),
        pixel_height=block.get("height"),
        x=x,
        y=y,
        width=width,
        height=height,
    )


def _page_manifest(page: pymupdf.Page, index: int, source_sha256: str) -> SlideManifest:
    typed_page = cast(_PdfPage, page)
    structure = cast(_PdfTextPage, typed_page.get_text("dict", sort=True))
    elements: list[StructuralElement] = []
    has_text = False
    has_image = False
    for block_index, block in enumerate(structure["blocks"], start=1):
        if block.get("type") == 0:
            text = _text_elements(block, block_index)
            elements.extend(text)
            has_text = has_text or bool(text)
        elif block.get("type") == 1:
            image = _image_element(block, block_index)
            if image is not None:
                elements.append(image)
                has_image = True

    warnings: list[ExtractionWarning] = []
    if has_image and not has_text:
        warnings.append(
            ExtractionWarning(
                code="scanned_page_requires_ocr",
                message="page has images but no extractable text; OCR/VLM was not performed",
            )
        )
    elif not elements:
        warnings.append(
            ExtractionWarning(
                code="no_extractable_content",
                message="page has no text or image structure; rendering was not performed",
            )
        )

    source_id = f"page:{index}"
    return SlideManifest(
        slide_key=slide_key(source_sha256, source_id),
        source_index=index,
        source_id=source_id,
        width_points=round(typed_page.rect.width, 4),
        height_points=round(typed_page.rect.height, 4),
        elements=tuple(elements),
        warnings=tuple(warnings),
    )


class PdfStructuralAdapter(StructuralAdapter):
    """Extract positioned PDF text and embedded images without rasterizing pages."""

    kind = InputKind.PDF
    adapter_version = "pymupdf-structural-v1"

    def extract(self, source: ValidatedInput) -> DeckManifest:
        self._require_kind(source)
        document: _PdfDocument | None = None
        try:
            document = cast(_PdfDocument, pymupdf.open(source.path))
            if document.needs_pass:
                raise StructuralExtractionError(
                    "encrypted_document", "encrypted PDFs are not supported"
                )
            manifests = tuple(
                _page_manifest(document.load_page(offset), offset + 1, source.source_sha256)
                for offset in range(document.page_count)
            )
        except StructuralExtractionError:
            raise
        except Exception as error:
            raise StructuralExtractionError(
                "invalid_document", "PDF structure could not be parsed"
            ) from error
        finally:
            if document is not None:
                document.close()

        if not manifests:
            raise StructuralExtractionError("empty_document", "PDF contains no pages")
        return DeckManifest(
            deck_id=deck_id(source.source_sha256),
            source_sha256=source.source_sha256,
            source_kind=self.kind,
            adapter_version=self.adapter_version,
            slides=manifests,
            render_boundary=RenderBoundary.structural_only(),
        )

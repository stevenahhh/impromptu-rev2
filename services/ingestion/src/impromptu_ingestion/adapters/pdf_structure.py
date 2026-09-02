"""PyMuPDF page structure model: typed blocks, element extraction, text-layer detection."""

import hashlib
from dataclasses import dataclass
from typing import Protocol, TypedDict, cast

import pymupdf

from impromptu_ingestion.contracts import (
    ImageElement,
    SlideManifest,
    StructuralElement,
    TextElement,
)


class PdfSpan(TypedDict):
    text: str
    bbox: tuple[float, float, float, float]


class PdfLine(TypedDict):
    spans: list[PdfSpan]


class PdfBlock(TypedDict, total=False):
    type: int
    bbox: tuple[float, float, float, float]
    lines: list[PdfLine]
    image: bytes
    ext: str
    width: int
    height: int


class PdfTextPage(TypedDict):
    blocks: list[PdfBlock]


class PdfDocument(Protocol):
    needs_pass: bool
    page_count: int

    def load_page(self, page_id: int) -> pymupdf.Page: ...

    def xref_length(self) -> int: ...

    def close(self) -> None: ...


def open_pdf_document(content: bytes) -> PdfDocument:
    """Open an in-memory PDF through the narrowed document surface."""
    return cast(PdfDocument, cast(object, pymupdf.open(stream=content, filetype="pdf")))


def page_structure(page: pymupdf.Page) -> PdfTextPage:
    """Read one page's sorted dict structure through the narrowed text surface."""
    typed_page = cast(PdfTextPageReader, cast(object, page))
    return cast(PdfTextPage, typed_page.get_text("dict", sort=True))


class PdfTextPageReader(Protocol):
    def get_text(self, option: str, *, sort: bool) -> object: ...


@dataclass(frozen=True)
class VisionTranscription:
    """Server-side transcription result for one raster-only page."""

    elements: tuple[TextElement, ...]
    model: str


@dataclass(frozen=True)
class PageExtraction:
    """Assembled manifest for one page plus the aggregate resource accounting."""

    manifest: SlideManifest
    element_count: int
    resource_bytes: int
    image_pixels: int


def position(bbox: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = bbox
    return (
        round(max(0.0, x0), 4),
        round(max(0.0, y0), 4),
        round(max(0.0, x1 - x0), 4),
        round(max(0.0, y1 - y0), 4),
    )


def _text_elements(block: PdfBlock, block_index: int) -> tuple[list[TextElement], int]:
    elements: list[TextElement] = []
    resource_bytes = 0
    for line_index, line in enumerate(block.get("lines", []), start=1):
        for span_index, span in enumerate(line["spans"], start=1):
            text = span["text"].strip()
            if text:
                resource_bytes += len(text.encode("utf-8"))
                x, y, width, height = position(span["bbox"])
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
    return elements, resource_bytes


def _image_element(block: PdfBlock, block_index: int) -> ImageElement | None:
    content = block.get("image")
    bbox = block.get("bbox")
    if not content or bbox is None:
        return None
    extension = block.get("ext", "unknown").lower()
    media_type = "image/jpeg" if extension in {"jpg", "jpeg"} else f"image/{extension}"
    x, y, width, height = position(bbox)
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


def page_has_text_layer(structure: PdfTextPage) -> bool:
    """A page carries an embedded text layer when any block holds a non-empty span."""
    for block in structure["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            if any(span["text"].strip() for span in line["spans"]):
                return True
    return False


def collect_block_elements(
    structure: PdfTextPage,
) -> tuple[list[StructuralElement], int, int, bool]:
    """Flatten one page's blocks into positioned elements with resource accounting."""
    elements: list[StructuralElement] = []
    resource_bytes = 0
    image_pixels = 0
    has_image = False
    for block_index, block in enumerate(structure["blocks"], start=1):
        match block.get("type"):
            case 0:
                text, text_bytes = _text_elements(block, block_index)
                elements.extend(text)
                resource_bytes += text_bytes
            case 1:
                image = _image_element(block, block_index)
                if image is not None:
                    elements.append(image)
                    content = block.get("image", b"")
                    resource_bytes += len(content)
                    image_pixels += block.get("width", 0) * block.get("height", 0)
                    has_image = True
            case _:
                # Any other block type carries no extractable structure.
                pass
    return elements, resource_bytes, image_pixels, has_image

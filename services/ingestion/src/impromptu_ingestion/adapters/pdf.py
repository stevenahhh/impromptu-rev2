"""Strict, bounded PyMuPDF structural extraction without rendering or OCR."""

import hashlib
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Protocol, TypedDict, cast

import pymupdf
from pydantic import TypeAdapter, ValidationError

from impromptu_ingestion.adapters.base import StructuralAdapter, StructuralExtractionError
from impromptu_ingestion.canonical import deck_id, slide_key
from impromptu_ingestion.contracts import (
    DeckManifest,
    ExtractionWarning,
    ImageElement,
    InputKind,
    PdfWorkerFailure,
    PdfWorkerSuccess,
    RenderBoundary,
    SlideManifest,
    StructuralElement,
    TextElement,
    ValidatedInput,
)
from impromptu_ingestion.ocr import OcrPage, extract_ocr_text

_PDF_TRAILER_BYTES = 65_536
_PDF_WORKER_RESPONSE = TypeAdapter[PdfWorkerSuccess | PdfWorkerFailure](
    PdfWorkerSuccess | PdfWorkerFailure
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


class _PdfPage(OcrPage, Protocol):
    def get_text(self, option: str, *, sort: bool) -> object: ...


class _PdfDocument(Protocol):
    needs_pass: bool
    page_count: int

    def load_page(self, page_id: int) -> pymupdf.Page: ...

    def xref_length(self) -> int: ...

    def close(self) -> None: ...


class _MuPdfTools(Protocol):
    def mupdf_warnings(self, reset: int = 1) -> str: ...


@dataclass(frozen=True)
class _PageExtraction:
    manifest: SlideManifest
    element_count: int
    resource_bytes: int
    image_pixels: int


def _position(bbox: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = bbox
    return (
        round(max(0.0, x0), 4),
        round(max(0.0, y0), 4),
        round(max(0.0, x1 - x0), 4),
        round(max(0.0, y1 - y0), 4),
    )


def _text_elements(block: _PdfBlock, block_index: int) -> tuple[list[TextElement], int]:
    elements: list[TextElement] = []
    resource_bytes = 0
    for line_index, line in enumerate(block.get("lines", []), start=1):
        for span_index, span in enumerate(line["spans"], start=1):
            text = span["text"].strip()
            if text:
                resource_bytes += len(text.encode("utf-8"))
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
    return elements, resource_bytes


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


def _page_manifest(
    page: pymupdf.Page, index: int, source_sha256: str, timeout_seconds: float
) -> _PageExtraction:
    typed_page = cast(_PdfPage, cast(object, page))
    structure = cast(_PdfTextPage, typed_page.get_text("dict", sort=True))
    elements: list[StructuralElement] = []
    resource_bytes = 0
    image_pixels = 0
    has_text = False
    has_image = False
    for block_index, block in enumerate(structure["blocks"], start=1):
        if block.get("type") == 0:
            text, text_bytes = _text_elements(block, block_index)
            elements.extend(text)
            resource_bytes += text_bytes
            has_text = has_text or bool(text)
        elif block.get("type") == 1:
            image = _image_element(block, block_index)
            if image is not None:
                elements.append(image)
                content = block.get("image", b"")
                resource_bytes += len(content)
                image_pixels += block.get("width", 0) * block.get("height", 0)
                has_image = True

    warnings: list[ExtractionWarning] = []
    if has_image and not has_text:
        try:
            ocr_elements = extract_ocr_text(typed_page, timeout_seconds=timeout_seconds)
        except StructuralExtractionError as error:
            if error.code != "ocr_unavailable":
                raise
            # OCR absence degrades this page to its image structure; it never blocks
            # ingestion of an otherwise readable deck. Hard failures stay reserved for
            # unreadable inputs such as encrypted documents.
            warnings.append(ExtractionWarning(code="ocr_unavailable", message=str(error)))
        else:
            elements.extend(ocr_elements)
            resource_bytes += sum(len(element.text.encode("utf-8")) for element in ocr_elements)
            warnings.append(
                ExtractionWarning(
                    code="ocr_applied",
                    message="local Tesseract OCR was applied to this raster-only page",
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
    manifest = SlideManifest(
        slide_key=slide_key(source_sha256, source_id),
        source_index=index,
        source_id=source_id,
        width_points=round(typed_page.rect.width, 4),
        height_points=round(typed_page.rect.height, 4),
        elements=tuple(elements),
        warnings=tuple(warnings),
    )
    return _PageExtraction(
        manifest=manifest,
        element_count=len(elements),
        resource_bytes=resource_bytes,
        image_pixels=image_pixels,
    )


def _validate_strict_trailer(content: bytes) -> None:
    trailer = content[-_PDF_TRAILER_BYTES:]
    if b"startxref" not in trailer:
        raise StructuralExtractionError("invalid_document", "PDF has no final cross-reference")
    match = re.search(rb"startxref\s+(\d+)\s+%%EOF\s*\Z", trailer)
    if match is None:
        raise StructuralExtractionError(
            "repair_required", "PDF final cross-reference or EOF marker is incomplete"
        )

    offset = int(match.group(1))
    if offset <= 0 or offset >= len(content):
        raise StructuralExtractionError("repair_required", "PDF cross-reference offset is invalid")
    cross_reference = content[offset : offset + 2_048]
    traditional = cross_reference.startswith(b"xref")
    xref_stream = bool(
        re.match(rb"\d+\s+\d+\s+obj\b", cross_reference)
        and re.search(rb"/Type\s*/XRef\b", cross_reference)
    )
    if not traditional and not xref_stream:
        raise StructuralExtractionError(
            "repair_required", "PDF final cross-reference target is invalid"
        )


def _raise_if_mupdf_warned(tools: _MuPdfTools) -> None:
    if tools.mupdf_warnings(reset=1).strip():
        raise StructuralExtractionError(
            "repair_required", "MuPDF reported format or repair diagnostics"
        )


def _check_limit(actual: int, maximum: int, resource: str) -> None:
    if actual > maximum:
        raise StructuralExtractionError(
            "resource_limit", f"PDF {resource} exceeds the configured limit"
        )


def extract_pdf_in_process(source: ValidatedInput) -> DeckManifest:
    try:
        content = source.path.read_bytes()
    except OSError as error:
        raise StructuralExtractionError(
            "staged_input_unreadable", "staged PDF could not be read"
        ) from error
    if hashlib.sha256(content).hexdigest() != source.source_sha256:
        raise StructuralExtractionError(
            "staged_input_changed", "staged PDF no longer matches its validated hash"
        )
    _validate_strict_trailer(content)

    tools = cast(_MuPdfTools, pymupdf.TOOLS)
    _ = tools.mupdf_warnings(reset=1)
    document: _PdfDocument | None = None
    try:
        document = cast(
            _PdfDocument, cast(object, pymupdf.open(stream=content, filetype="pdf"))
        )
        _raise_if_mupdf_warned(tools)
        if document.needs_pass:
            raise StructuralExtractionError(
                "encrypted_document", "encrypted PDFs are not supported"
            )

        limits = source.limits
        _check_limit(document.page_count, limits.max_pdf_pages, "page count")
        _check_limit(document.xref_length(), limits.max_pdf_objects, "object count")

        manifests: list[SlideManifest] = []
        element_count = 0
        resource_bytes = 0
        image_pixels = 0
        for offset in range(document.page_count):
            extracted = _page_manifest(
                document.load_page(offset),
                offset + 1,
                source.source_sha256,
                limits.operation_timeout_seconds,
            )
            manifests.append(extracted.manifest)
            element_count += extracted.element_count
            resource_bytes += extracted.resource_bytes
            image_pixels += extracted.image_pixels
            _check_limit(element_count, limits.max_pdf_elements, "element count")
            _check_limit(resource_bytes, limits.max_pdf_resource_bytes, "resource bytes")
            _check_limit(image_pixels, limits.max_pdf_image_pixels, "image pixels")
        _raise_if_mupdf_warned(tools)
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
        source_kind=InputKind.PDF,
        adapter_version="pymupdf-structural-ocr-v3",
        slides=tuple(manifests),
        render_boundary=RenderBoundary.structural_only(),
    )


def _run_bounded_worker(source: ValidatedInput) -> DeckManifest:
    command = [sys.executable, "-m", "impromptu_ingestion.pdf_worker"]
    try:
        completed = subprocess.run(
            command,
            input=source.model_dump_json().encode("utf-8"),
            capture_output=True,
            check=False,
            timeout=source.limits.operation_timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        raise StructuralExtractionError(
            "operation_timeout", "PDF extraction exceeded its operation deadline"
        ) from error
    except OSError as error:
        raise StructuralExtractionError(
            "worker_unavailable", "PDF extraction worker could not be started"
        ) from error

    if completed.returncode != 0:
        raise StructuralExtractionError(
            "worker_failed", "PDF extraction worker exited unexpectedly"
        )
    try:
        response = _PDF_WORKER_RESPONSE.validate_json(completed.stdout)
    except ValidationError as error:
        raise StructuralExtractionError(
            "worker_failed", "PDF extraction worker returned an invalid response"
        ) from error
    if isinstance(response, PdfWorkerFailure):
        raise StructuralExtractionError(response.code, response.message)
    return response.manifest


class PdfStructuralAdapter(StructuralAdapter):
    """Extract PDF structure in an isolated process with strict limits and timeout."""

    kind = InputKind.PDF
    adapter_version = "pymupdf-structural-ocr-v3"

    def extract(self, source: ValidatedInput) -> DeckManifest:
        self._require_kind(source)
        return _run_bounded_worker(source)

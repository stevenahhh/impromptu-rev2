"""Strict, bounded PyMuPDF structural extraction without rendering."""

# Page-structure reading lives in ``pdf_structure``; untrusted-input guards in
# ``pdf_guards``; the isolated worker subprocess boundary in
# ``pdf_worker_client``. This module keeps the extraction orchestration: page
# manifest assembly and the OCR / vision fallback decision per raster-only page.

import hashlib
import time
from typing import cast

import pymupdf

from impromptu_ingestion import vision
from impromptu_ingestion.adapters.base import StructuralAdapter, StructuralExtractionError
from impromptu_ingestion.adapters.pdf_guards import (
    check_limit,
    mupdf_tools,
    raise_if_mupdf_warned,
    validate_strict_trailer,
)
from impromptu_ingestion.adapters.pdf_structure import (
    PageExtraction,
    PdfDocument,
    PdfTextPage,
    VisionTranscription,
    collect_block_elements,
    open_pdf_document,
    page_has_text_layer,
    page_structure,
)
from impromptu_ingestion.adapters.pdf_worker_client import (
    VISION_OPERATION_ALLOWANCE_SECONDS,
    run_bounded_worker,
)
from impromptu_ingestion.canonical import deck_id, slide_key
from impromptu_ingestion.contracts import (
    DeckManifest,
    ExtractionWarning,
    InputKind,
    RenderBoundary,
    SlideManifest,
    TextElement,
    ValidatedInput,
)
from impromptu_ingestion.ocr import OcrPage, extract_ocr_text
from impromptu_ingestion.vision import (
    TranscriptionJob,
    VisionConfig,
    render_vision_jpeg,
    transcribe_pages,
    vision_config,
)

# Wall-clock reserve for the guaranteed Tesseract fallback of every raster page
# plus manifest serialization, so vision can never starve the deterministic path.
_TESSERACT_FALLBACK_RESERVE_PER_PAGE_SECONDS = 2.5
_VISION_MIN_BUDGET_SECONDS = 6.0


def _raster_page_text(
    typed_page: OcrPage,
    *,
    timeout_seconds: float,
    vision_transcription: VisionTranscription | None,
    warnings: list[ExtractionWarning],
) -> tuple[TextElement, ...]:
    """Resolve text for a raster-only page: configured vision model first, else local OCR."""
    if vision_transcription is not None:
        warnings.append(
            ExtractionWarning(
                code="vision_ocr_applied",
                message="server-side vision transcription by "
                f"{vision_transcription.model} produced this raster-only page's text",
            )
        )
        return vision_transcription.elements
    try:
        ocr_elements = extract_ocr_text(typed_page, timeout_seconds=timeout_seconds)
    except StructuralExtractionError as error:
        if error.code != "ocr_unavailable":
            raise
        # OCR absence degrades this page to its image structure; it never blocks
        # ingestion of an otherwise readable deck. Hard failures stay reserved for
        # unreadable inputs such as encrypted documents.
        warnings.append(ExtractionWarning(code="ocr_unavailable", message=str(error)))
        return ()
    warnings.append(
        ExtractionWarning(
            code="ocr_applied",
            message="local Tesseract OCR was applied to this raster-only page",
        )
    )
    return ocr_elements


def _page_manifest(
    page: pymupdf.Page,
    index: int,
    source_sha256: str,
    timeout_seconds: float,
    structure: PdfTextPage,
    vision_transcription: VisionTranscription | None,
) -> PageExtraction:
    typed_page = cast(OcrPage, cast(object, page))
    elements, resource_bytes, image_pixels, has_image = collect_block_elements(structure)

    warnings: list[ExtractionWarning] = []
    if has_image and not page_has_text_layer(structure):
        raster_text = _raster_page_text(
            typed_page,
            timeout_seconds=timeout_seconds,
            vision_transcription=vision_transcription,
            warnings=warnings,
        )
        elements.extend(raster_text)
        resource_bytes += sum(len(element.text.encode("utf-8")) for element in raster_text)
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
    return PageExtraction(
        manifest=manifest,
        element_count=len(elements),
        resource_bytes=resource_bytes,
        image_pixels=image_pixels,
    )


def _collect_vision_transcriptions(
    document: PdfDocument,
    page_count: int,
    structures: dict[int, PdfTextPage],
    deadline: float,
    config: VisionConfig | None,
) -> dict[int, VisionTranscription]:
    """Transcribe raster-only pages server-side within the operation deadline.

    The Tesseract fallback always keeps a wall-clock reserve so a slow or failed
    model call can never push ingestion past its bounded deadline.
    """
    if config is None:
        return {}
    jobs: dict[int, TranscriptionJob] = {}
    for offset in range(page_count):
        structure = structures[offset]
        if page_has_text_layer(structure):
            continue
        if not any(block.get("type") == 1 for block in structure["blocks"]):
            continue
        # Rasterization happens on this thread: PyMuPDF documents are not
        # thread-safe, only the network calls run concurrently.
        page = document.load_page(offset)
        jpeg = render_vision_jpeg(cast(vision.RasterizablePage, cast(object, page)))
        if jpeg is None:
            continue
        jobs[offset] = TranscriptionJob(
            jpeg=jpeg,
            page_width=float(page.rect.width),
            page_height=float(page.rect.height),
        )
    if not jobs:
        return {}
    reserve = _TESSERACT_FALLBACK_RESERVE_PER_PAGE_SECONDS * len(jobs) + 1.0
    remaining = deadline - time.monotonic()
    if remaining - reserve < _VISION_MIN_BUDGET_SECONDS:
        return {}
    transcriptions = transcribe_pages(
        jobs,
        config=config,
        timeout_seconds=remaining - reserve,
    )
    return {
        index: VisionTranscription(elements=elements, model=config.model)
        for index, elements in transcriptions.items()
    }


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
    validate_strict_trailer(content)

    tools = mupdf_tools()
    _ = tools.mupdf_warnings(reset=1)
    document: PdfDocument | None = None
    try:
        document = open_pdf_document(content)
        raise_if_mupdf_warned(tools)
        if document.needs_pass:
            raise StructuralExtractionError(
                "encrypted_document", "encrypted PDFs are not supported"
            )

        limits = source.limits
        check_limit(document.page_count, limits.max_pdf_pages, "page count")
        check_limit(document.xref_length(), limits.max_pdf_objects, "object count")

        configured_vision = vision_config()
        # A configured vision model opts the operator into server-side latency;
        # without configuration the budget is exactly what the caller set.
        deadline = (
            time.monotonic()
            + limits.operation_timeout_seconds
            + (VISION_OPERATION_ALLOWANCE_SECONDS if configured_vision is not None else 0.0)
        )
        structures = {
            offset: page_structure(document.load_page(offset))
            for offset in range(document.page_count)
        }
        vision_transcriptions = _collect_vision_transcriptions(
            document, document.page_count, structures, deadline, configured_vision
        )

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
                structures[offset],
                vision_transcriptions.get(offset),
            )
            manifests.append(extracted.manifest)
            element_count += extracted.element_count
            resource_bytes += extracted.resource_bytes
            image_pixels += extracted.image_pixels
            check_limit(element_count, limits.max_pdf_elements, "element count")
            check_limit(resource_bytes, limits.max_pdf_resource_bytes, "resource bytes")
            check_limit(image_pixels, limits.max_pdf_image_pixels, "image pixels")
        raise_if_mupdf_warned(tools)
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
        adapter_version="pymupdf-structural-ocr-v4",
        slides=tuple(manifests),
        render_boundary=RenderBoundary.structural_only(),
    )


class PdfStructuralAdapter(StructuralAdapter):
    """Extract PDF structure in an isolated process with strict limits and timeout."""

    kind = InputKind.PDF
    adapter_version = "pymupdf-structural-ocr-v4"

    def extract(self, source: ValidatedInput) -> DeckManifest:
        self._require_kind(source)
        return run_bounded_worker(source)

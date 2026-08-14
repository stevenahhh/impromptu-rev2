from pathlib import Path

import pytest

from impromptu_ingestion.adapters import (
    PdfStructuralAdapter,
    PptxStructuralAdapter,
    RenderingUnsupportedError,
    StructuralExtractionError,
)
from impromptu_ingestion.canonical import canonical_manifest_bytes, manifest_sha256
from impromptu_ingestion.contracts import IngestionJob, InputKind, ValidatedInput
from impromptu_ingestion.validation import validate_input


def _validated(path: Path) -> ValidatedInput:
    return validate_input(IngestionJob(job_id="job_adapter_01", source=path))


def test_pptx_extracts_text_table_image_and_chart_without_private_notes(
    sample_pptx: Path,
) -> None:
    manifest = PptxStructuralAdapter().extract(_validated(sample_pptx))

    assert manifest.source_kind is InputKind.PPTX
    assert len(manifest.slides) == 1
    assert {element.kind for element in manifest.slides[0].elements} == {
        "text",
        "table",
        "image",
        "chart",
    }
    assert b"PRIVATE-NOTES-MUST-NEVER-LEAK" not in canonical_manifest_bytes(manifest)
    assert manifest.render_boundary.fidelity_verified is False


def test_pptx_manifest_and_identity_are_repeatable(sample_pptx: Path) -> None:
    adapter = PptxStructuralAdapter()
    validated = _validated(sample_pptx)

    first = adapter.extract(validated)
    second = adapter.extract(validated)

    assert canonical_manifest_bytes(first) == canonical_manifest_bytes(second)
    assert manifest_sha256(first) == manifest_sha256(second)
    assert first.deck_id.startswith("deck_")
    assert first.slides[0].slide_key.startswith("slide_")


def test_pdf_extracts_positioned_text_and_images_and_marks_scanned_pages(
    sample_pdf: Path,
) -> None:
    manifest = PdfStructuralAdapter().extract(_validated(sample_pdf))

    assert manifest.source_kind is InputKind.PDF
    assert len(manifest.slides) == 2
    assert any(element.kind == "text" for element in manifest.slides[0].elements)
    assert any(element.kind == "image" for element in manifest.slides[0].elements)
    assert {warning.code for warning in manifest.slides[1].warnings} == {
        "scanned_page_requires_ocr"
    }
    assert all(element.kind != "text" for element in manifest.slides[1].elements)


@pytest.mark.parametrize("adapter", [PptxStructuralAdapter(), PdfStructuralAdapter()])
def test_rendering_is_an_explicit_unsupported_boundary(
    adapter: PptxStructuralAdapter | PdfStructuralAdapter,
) -> None:
    with pytest.raises(RenderingUnsupportedError, match="not configured"):
        adapter.render_slides()


def test_malformed_pdf_fails_with_a_typed_extraction_error(tmp_path: Path) -> None:
    source = tmp_path / "malformed.pdf"
    source.write_bytes(b"%PDF-1.7\nthis is not a document")

    with pytest.raises(StructuralExtractionError) as raised:
        PdfStructuralAdapter().extract(_validated(source))

    assert raised.value.code == "invalid_document"

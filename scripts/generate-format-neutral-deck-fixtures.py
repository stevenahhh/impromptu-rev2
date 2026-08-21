# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["PyMuPDF==1.28.2", "python-pptx==1.0.2"]
# ///
"""Generate byte-stable Korean PPTX, text-layer PDF, and scanned PDF fixtures."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

import pymupdf
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "format-neutral-decks"
PPTX_PATH = FIXTURE_DIR / "korean-structural.pptx"
TEXT_PDF_PATH = FIXTURE_DIR / "korean-text-layer.pdf"
SCANNED_PDF_PATH = FIXTURE_DIR / "korean-scanned.pdf"
MANIFEST_PATH = FIXTURE_DIR / "fixture-manifest.json"

SENTINEL = "형식 중립 근거 자료 2026"
FORBIDDEN_PPTX_SENTINEL = "<date/time>"
FIXED_DATETIME = datetime(2024, 1, 1, tzinfo=UTC)
FIXED_ZIP_TIME = (2024, 1, 1, 0, 0, 0)
PAGE_WIDTH = 720
PAGE_HEIGHT = 405


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _zip_info(name: str) -> ZipInfo:
    info = ZipInfo(name, FIXED_ZIP_TIME)
    info.compress_type = ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o600 << 16
    return info


def _normalize_pptx_archive(path: Path) -> None:
    with ZipFile(path) as source:
        entries = {name: source.read(name) for name in source.namelist() if not name.endswith("/")}
    with TemporaryDirectory() as temporary:
        rebuilt = Path(temporary) / path.name
        with ZipFile(rebuilt, "w", compression=ZIP_DEFLATED, compresslevel=9) as output:
            for name in sorted(entries):
                output.writestr(_zip_info(name), entries[name])
        path.write_bytes(rebuilt.read_bytes())


def _generate_pptx() -> None:
    deck = Presentation()
    deck.slide_width = Inches(10)
    deck.slide_height = Inches(5.625)
    deck.core_properties.title = "Format-neutral Korean ingestion fixture"
    deck.core_properties.subject = "Synthetic fixture for structural extraction"
    deck.core_properties.author = "Impromptu fixture generator"
    deck.core_properties.created = FIXED_DATETIME
    deck.core_properties.modified = FIXED_DATETIME
    deck.core_properties.last_modified_by = "Impromptu fixture generator"
    deck.core_properties.revision = 1

    slide = deck.slides.add_slide(deck.slide_layouts[6])
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = RGBColor(250, 250, 250)
    box = slide.shapes.add_textbox(Inches(1), Inches(1.5), Inches(8), Inches(1.25))
    frame = box.text_frame
    frame.clear()
    frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    run = frame.paragraphs[0].add_run()
    run.text = SENTINEL
    run.font.name = "Apple SD Gothic Neo"
    run.font.size = Pt(28)
    run.font.bold = True
    run.font.color.rgb = RGBColor(24, 24, 27)

    deck.save(PPTX_PATH)
    _normalize_pptx_archive(PPTX_PATH)


def _set_pdf_metadata(document: pymupdf.Document, title: str) -> None:
    document.set_metadata(
        {
            "title": title,
            "author": "Impromptu fixture generator",
            "subject": "Synthetic Korean ingestion fixture",
            "keywords": "impromptu,fixture,korean",
            "creator": "scripts/generate-format-neutral-deck-fixtures.py",
            "producer": "PyMuPDF 1.28.2",
            "creationDate": "D:20240101000000Z",
            "modDate": "D:20240101000000Z",
        }
    )


def _save_pdf(document: pymupdf.Document, path: Path) -> None:
    document.save(path, garbage=4, clean=True, deflate=True, no_new_id=True)
    document.close()


def _insert_fixture_text(page: pymupdf.Page) -> None:
    page.draw_rect(
        pymupdf.Rect(36, 36, PAGE_WIDTH - 36, PAGE_HEIGHT - 36),
        color=(0.145, 0.388, 0.922),
        width=2,
    )
    page.insert_text(
        (72, 190),
        SENTINEL,
        fontname="korea",
        fontsize=28,
        color=(0.094, 0.094, 0.106),
    )


def _generate_text_pdf() -> None:
    document = pymupdf.open()
    page = document.new_page(width=PAGE_WIDTH, height=PAGE_HEIGHT)
    _insert_fixture_text(page)
    _set_pdf_metadata(document, "Korean text-layer fixture")
    _save_pdf(document, TEXT_PDF_PATH)


def _generate_scanned_pdf() -> None:
    source = pymupdf.open()
    source_page = source.new_page(width=PAGE_WIDTH, height=PAGE_HEIGHT)
    _insert_fixture_text(source_page)
    pixmap = source_page.get_pixmap(matrix=pymupdf.Matrix(2, 2), colorspace=pymupdf.csRGB, alpha=False)
    image = pixmap.tobytes("png")
    source.close()

    document = pymupdf.open()
    page = document.new_page(width=PAGE_WIDTH, height=PAGE_HEIGHT)
    page.insert_image(page.rect, stream=image)
    _set_pdf_metadata(document, "Korean scanned-image fixture")
    _save_pdf(document, SCANNED_PDF_PATH)


def _fixture_entry(
    fixture_id: str,
    kind: str,
    path: Path,
    source_method: str,
    expected_semantics: str,
) -> dict[str, object]:
    return {
        "id": fixture_id,
        "kind": kind,
        "path": path.relative_to(ROOT).as_posix(),
        "sha256": _sha256(path),
        "expectedSemantics": expected_semantics,
        "provenance": {
            "origin": "repository-generated synthetic fixture",
            "sourceMethod": source_method,
            "thirdPartySourceMaterial": False,
            "generatedBy": "scripts/generate-format-neutral-deck-fixtures.py",
        },
    }


def _write_manifest() -> None:
    manifest = {
        "schemaVersion": 1,
        "registryId": "impromptu-format-neutral-korean-decks-v1",
        "generator": {
            "path": "scripts/generate-format-neutral-deck-fixtures.py",
            "command": "uv run scripts/generate-format-neutral-deck-fixtures.py",
            "requiresPython": ">=3.14,<3.15",
            "dependencies": ["PyMuPDF==1.28.2", "python-pptx==1.0.2"],
        },
        "sentinels": {
            "structural": SENTINEL,
            "ocr": SENTINEL,
            "forbiddenPptxText": FORBIDDEN_PPTX_SENTINEL,
        },
        "fixtures": [
            _fixture_entry(
                "korean-structural-pptx",
                "pptx",
                PPTX_PATH,
                "python-pptx blank slide with one native Korean text shape; ZIP metadata normalized",
                "DeckManifest contains the structural sentinel as one TextElement",
            ),
            _fixture_entry(
                "korean-text-layer-pdf",
                "text-layer-pdf",
                TEXT_PDF_PATH,
                "PyMuPDF page with native Korean PDF text using the built-in Korea CJK font",
                "DeckManifest contains the same structural sentinel as the PPTX fixture",
            ),
            _fixture_entry(
                "korean-scanned-pdf",
                "scanned-pdf",
                SCANNED_PDF_PATH,
                "2x rasterization of the synthetic Korean page embedded as the PDF page's only image",
                "DeckManifest has no TextElement and warns scanned_page_requires_ocr; OCR target is the OCR sentinel",
            ),
        ],
        "migrationReservations": {
            "private": [
                {"filename": "0008_deck_retrieval_hybrid.sql", "owner": "retrieval"},
                {"filename": "0009_session_reports.sql", "owner": "report"},
            ],
            "projection": {"latest": "0005_gateway_state.sql", "newMigrationAllowed": False},
        },
    }
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    _generate_pptx()
    _generate_text_pdf()
    _generate_scanned_pdf()
    _write_manifest()
    for fixture in (PPTX_PATH, TEXT_PDF_PATH, SCANNED_PDF_PATH):
        print(f"{fixture.relative_to(ROOT)} {_sha256(fixture)}")


if __name__ == "__main__":
    main()

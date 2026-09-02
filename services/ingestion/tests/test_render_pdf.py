"""Contract tests for static PDF page rasterization quality and geometry."""

import json
import struct
from pathlib import Path

import pymupdf

from impromptu_ingestion.render.pdf import render_pdf_pages

_PNG_IHDR_SIZE_OFFSET = 16


def _png_dimensions(png: bytes) -> tuple[int, int]:
    width, height = struct.unpack(">II", png[_PNG_IHDR_SIZE_OFFSET : _PNG_IHDR_SIZE_OFFSET + 8])
    return width, height


def _render(sample_pdf: Path, tmp_path: Path) -> Path:
    output_dir = tmp_path / "out"
    render_pdf_pages(sample_pdf, output_dir)
    return output_dir


def test_standard_slide_renders_at_target_dpi(sample_pdf: Path, tmp_path: Path) -> None:
    output_dir = _render(sample_pdf, tmp_path)
    # 720x405pt page at 192 DPI (zoom 8/3) must land at exactly 1920x1080 px,
    # supersampled and crisp on a full-screen 1080p audience display.
    assert _png_dimensions((output_dir / "slides/slide-1.png").read_bytes()) == (1920, 1080)
    assert _png_dimensions((output_dir / "slides/slide-2.png").read_bytes()) == (1920, 1080)


def test_oversized_page_is_capped_at_pixel_ceiling(tmp_path: Path) -> None:
    source = tmp_path / "poster.pdf"
    document = pymupdf.open()
    document.new_page(width=2400, height=1200)  # 192 DPI would exceed the 3840 px ceiling
    document.save(source)
    document.close()

    output_dir = tmp_path / "out"
    render_pdf_pages(source, output_dir)
    assert _png_dimensions((output_dir / "slides/slide-1.png").read_bytes()) == (3840, 1920)


def test_geometry_fields_stay_in_page_points(sample_pdf: Path, tmp_path: Path) -> None:
    output_dir = _render(sample_pdf, tmp_path)
    rendered = json.loads((output_dir / "render.json").read_text(encoding="utf-8"))
    slides = rendered["slides"]
    assert [slide["source_index"] for slide in slides] == [1, 2]
    assert [slide["relative_path"] for slide in slides] == [
        "slides/slide-1.png",
        "slides/slide-2.png",
    ]
    # Raster scale must never leak into the point-space geometry other services parse.
    for slide, (width, height) in zip(slides, [(720.0, 405.0), (720.0, 405.0)], strict=True):
        assert slide["width_points"] == width
        assert slide["height_points"] == height

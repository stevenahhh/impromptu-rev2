"""Bounded local Tesseract OCR for raster-only PDF pages.

Engine installation verification, page rasterization, and the single bounded
engine call live here. TSV parsing and Hangul-aware line reconstruction live in
``ocr_transcript``.
"""

import hashlib
import os
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

import pymupdf

from impromptu_ingestion.contracts import TextElement
from impromptu_ingestion.ocr_transcript import line_elements, ocr_unavailable, parse_words

# ~300 DPI is the accepted floor for Tesseract accuracy on presentation
# slides; below it Hangul glyphs blur and misrecognition rates climb.
_OCR_DPI = 300
_MAX_OCR_EDGE = 4_096
# PSM 6 (one uniform text block) restores the spaced-glyph Korean slide title
# exactly; sparse-text modes (PSM 11/12) fragment spaced words into separate
# line keys and corrupt the reconstructed line.
_TESSERACT_COMMAND = (
    "tesseract",
    "stdin",
    "stdout",
    "-l",
    "kor+eng",
    "--oem",
    "1",
    "--psm",
    "6",
    "tsv",
)
_MODEL_SPECS = {
    "kor": (
        1_677_415,
        "6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2",
    ),
    "eng": (
        4_113_088,
        "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
    ),
}


class _PdfRect(Protocol):
    width: float
    height: float


class _PdfPixmap(Protocol):
    width: int
    height: int

    def tobytes(self, output: str) -> bytes: ...


class OcrPage(Protocol):
    rect: _PdfRect

    def get_pixmap(
        self, *, matrix: pymupdf.Matrix, alpha: bool, colorspace: pymupdf.Colorspace
    ) -> _PdfPixmap: ...


OcrRunner = Callable[..., subprocess.CompletedProcess[bytes]]


def _tessdata_directory() -> Path:
    configured = os.environ.get("TESSDATA_PREFIX")
    if configured is None or not configured.strip():
        raise ocr_unavailable("pinned Tesseract model directory is not configured")
    return Path(configured)


def _verify_installation() -> None:
    if shutil.which(_TESSERACT_COMMAND[0]) is None:
        raise ocr_unavailable("Tesseract binary is missing")

    tessdata = _tessdata_directory()
    for language, (expected_bytes, expected_sha256) in _MODEL_SPECS.items():
        model = tessdata / f"{language}.traineddata"
        try:
            content = model.read_bytes()
        except OSError as error:
            raise ocr_unavailable(f"pinned {language} model is missing") from error
        if len(content) != expected_bytes or hashlib.sha256(content).hexdigest() != expected_sha256:
            raise ocr_unavailable(f"pinned {language} model failed integrity verification")


def _rasterize(page: OcrPage) -> tuple[bytes, int, int]:
    longest_points = max(page.rect.width, page.rect.height)
    if longest_points <= 0:
        raise ocr_unavailable("scanned page has no measurable size")
    zoom = min(_OCR_DPI / 72.0, _MAX_OCR_EDGE / longest_points)
    try:
        pixmap = page.get_pixmap(
            matrix=pymupdf.Matrix(zoom, zoom),
            alpha=False,
            colorspace=pymupdf.csRGB,
        )
        png = pixmap.tobytes("png")
    except Exception as error:
        # Rasterization runs over third-party parser state; any failure there is
        # an OCR availability problem, never a reason to fail the whole deck.
        raise ocr_unavailable("scanned page rasterization failed") from error
    if not png or pixmap.width <= 0 or pixmap.height <= 0:
        raise ocr_unavailable("scanned page rasterization produced no image")
    if max(pixmap.width, pixmap.height) > _MAX_OCR_EDGE:
        raise ocr_unavailable("scanned page raster exceeded the configured edge limit")
    return png, pixmap.width, pixmap.height


def extract_ocr_text(
    page: OcrPage,
    *,
    timeout_seconds: float,
    runner: OcrRunner = subprocess.run,
) -> tuple[TextElement, ...]:
    """OCR one confirmed raster-only page with one bounded local engine call."""
    _verify_installation()
    png, raster_width, raster_height = _rasterize(page)
    # Leave the isolated PDF worker enough time to serialize this typed OCR timeout
    # before its enclosing operation deadline expires.
    ocr_timeout_seconds = max(0.1, timeout_seconds - 0.25)
    try:
        completed = runner(
            list(_TESSERACT_COMMAND),
            input=png,
            capture_output=True,
            check=False,
            shell=False,
            timeout=ocr_timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        raise ocr_unavailable("Tesseract exceeded its operation deadline") from error
    except OSError as error:
        raise ocr_unavailable("Tesseract binary could not be started") from error
    if completed.returncode != 0:
        raise ocr_unavailable(f"Tesseract exited nonzero ({completed.returncode})")
    words = parse_words(completed.stdout)
    return line_elements(words, page.rect.width, page.rect.height, raster_width, raster_height)

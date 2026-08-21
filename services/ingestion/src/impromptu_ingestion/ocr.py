"""Bounded local Tesseract OCR for raster-only PDF pages."""

import csv
import hashlib
import io
import os
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import pymupdf

from impromptu_ingestion.adapters.base import StructuralExtractionError
from impromptu_ingestion.contracts import TextElement

_OCR_DPI = 200
_MAX_OCR_EDGE = 4_096
_TESSERACT_COMMAND = (
    "tesseract",
    "stdin",
    "stdout",
    "-l",
    "kor+eng",
    "--oem",
    "1",
    "--psm",
    "11",
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
_REQUIRED_TSV_COLUMNS = {
    "level",
    "page_num",
    "block_num",
    "par_num",
    "line_num",
    "left",
    "top",
    "width",
    "height",
    "text",
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


@dataclass(frozen=True)
class _Word:
    line_key: tuple[int, int, int, int]
    text: str
    left: int
    top: int
    right: int
    bottom: int


def _unavailable(detail: str) -> StructuralExtractionError:
    return StructuralExtractionError(
        "ocr_unavailable", f"scanned_page_requires_ocr: {detail}"
    )


def _tessdata_directory() -> Path:
    configured = os.environ.get("TESSDATA_PREFIX")
    if configured is None or not configured.strip():
        raise _unavailable("pinned Tesseract model directory is not configured")
    return Path(configured)


def _verify_installation() -> None:
    if shutil.which(_TESSERACT_COMMAND[0]) is None:
        raise _unavailable("Tesseract binary is missing")

    tessdata = _tessdata_directory()
    for language, (expected_bytes, expected_sha256) in _MODEL_SPECS.items():
        model = tessdata / f"{language}.traineddata"
        try:
            content = model.read_bytes()
        except OSError as error:
            raise _unavailable(f"pinned {language} model is missing") from error
        if len(content) != expected_bytes or hashlib.sha256(content).hexdigest() != expected_sha256:
            raise _unavailable(f"pinned {language} model failed integrity verification")


def _rasterize(page: OcrPage) -> tuple[bytes, int, int]:
    longest_points = max(page.rect.width, page.rect.height)
    if longest_points <= 0:
        raise _unavailable("scanned page has no measurable size")
    zoom = min(_OCR_DPI / 72.0, _MAX_OCR_EDGE / longest_points)
    try:
        pixmap = page.get_pixmap(
            matrix=pymupdf.Matrix(zoom, zoom),
            alpha=False,
            colorspace=pymupdf.csRGB,
        )
        png = pixmap.tobytes("png")
    except Exception as error:
        raise _unavailable("scanned page rasterization failed") from error
    if not png or pixmap.width <= 0 or pixmap.height <= 0:
        raise _unavailable("scanned page rasterization produced no image")
    if max(pixmap.width, pixmap.height) > _MAX_OCR_EDGE:
        raise _unavailable("scanned page raster exceeded the configured edge limit")
    return png, pixmap.width, pixmap.height


def _integer(row: dict[str, str | None], name: str) -> int | None:
    value = row.get(name)
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def _parse_words(tsv: bytes) -> list[_Word]:
    try:
        text = tsv.decode("utf-8")
    except UnicodeDecodeError as error:
        raise _unavailable("Tesseract returned non-UTF-8 TSV") from error
    if not text.strip():
        raise _unavailable("Tesseract returned empty TSV")

    reader = csv.DictReader(io.StringIO(text), delimiter="\t")
    if reader.fieldnames is None or not _REQUIRED_TSV_COLUMNS.issubset(reader.fieldnames):
        raise _unavailable("Tesseract returned empty TSV")

    words: list[_Word] = []
    for row in reader:
        value = (row.get("text") or "").strip()
        level = _integer(row, "level")
        left = _integer(row, "left")
        top = _integer(row, "top")
        width = _integer(row, "width")
        height = _integer(row, "height")
        page_num = _integer(row, "page_num")
        block_num = _integer(row, "block_num")
        par_num = _integer(row, "par_num")
        line_num = _integer(row, "line_num")
        if (
            level != 5
            or not value
            or left is None
            or top is None
            or width is None
            or height is None
            or width <= 0
            or height <= 0
            or page_num is None
            or block_num is None
            or par_num is None
            or line_num is None
        ):
            continue
        words.append(
            _Word(
                line_key=(page_num, block_num, par_num, line_num),
                text=value,
                left=max(0, left),
                top=max(0, top),
                right=max(0, left + width),
                bottom=max(0, top + height),
            )
        )
    if not words:
        raise _unavailable("Tesseract returned empty TSV")
    return words


def _line_elements(
    words: list[_Word], page: OcrPage, raster_width: int, raster_height: int
) -> tuple[TextElement, ...]:
    grouped: dict[tuple[int, int, int, int], list[_Word]] = {}
    for word in words:
        grouped.setdefault(word.line_key, []).append(word)

    x_scale = page.rect.width / raster_width
    y_scale = page.rect.height / raster_height
    elements: list[TextElement] = []
    for line_index, line_words in enumerate(grouped.values(), start=1):
        left = min(word.left for word in line_words)
        top = min(word.top for word in line_words)
        right = max(word.right for word in line_words)
        bottom = max(word.bottom for word in line_words)
        elements.append(
            TextElement(
                element_id=f"ocr:text:{line_index}",
                text=" ".join(word.text for word in line_words),
                x=round(left * x_scale, 4),
                y=round(top * y_scale, 4),
                width=round((right - left) * x_scale, 4),
                height=round((bottom - top) * y_scale, 4),
            )
        )
    return tuple(elements)


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
        raise _unavailable("Tesseract exceeded its operation deadline") from error
    except OSError as error:
        raise _unavailable("Tesseract binary could not be started") from error
    if completed.returncode != 0:
        raise _unavailable(f"Tesseract exited nonzero ({completed.returncode})")
    words = _parse_words(completed.stdout)
    return _line_elements(words, page, raster_width, raster_height)

import subprocess
from pathlib import Path

import pymupdf
import pytest

from impromptu_ingestion.adapters import PdfStructuralAdapter
from impromptu_ingestion.adapters.base import StructuralExtractionError
from impromptu_ingestion.contracts import IngestionJob
from impromptu_ingestion.ocr import _rasterize, extract_ocr_text
from impromptu_ingestion.validation import stage_input

_TSV_HEADER = (
    b"level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\t"
    b"height\tconf\ttext\n"
)
_VALID_TSV = _TSV_HEADER + (
    "5\t1\t1\t1\t1\t1\t200\t100\t400\t80\t96\t형식 중립\n"
    "5\t1\t1\t1\t1\t2\t620\t100\t180\t80\t95\t근거 2026\n"
).encode()


class _Pixmap:
    width = 2000
    height = 1000

    def tobytes(self, output: str) -> bytes:
        assert output == "png"
        return b"synthetic-png"


class _Rect:
    width = 720.0
    height = 360.0


class _Page:
    rect = _Rect()

    def __init__(self) -> None:
        self.matrix: pymupdf.Matrix | None = None
        self.alpha: bool | None = None
        self.colorspace: pymupdf.Colorspace | None = None

    def get_pixmap(
        self, *, matrix: pymupdf.Matrix, alpha: bool, colorspace: pymupdf.Colorspace
    ) -> _Pixmap:
        self.matrix = matrix
        self.alpha = alpha
        self.colorspace = colorspace
        return _Pixmap()


def _available(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("impromptu_ingestion.ocr._verify_installation", lambda: None)


def _raised(call: object) -> StructuralExtractionError:
    assert isinstance(call, StructuralExtractionError)
    assert call.code == "ocr_unavailable"
    assert "scanned_page_requires_ocr" in str(call)
    return call


def test_ocr_runs_exact_bounded_tesseract_tsv_command_and_maps_line_bbox(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _available(monkeypatch)
    page = _Page()
    invocations: list[tuple[list[str], dict[str, object]]] = []

    def runner(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
        invocations.append((command, options))
        return subprocess.CompletedProcess(command, 0, stdout=_VALID_TSV, stderr=b"")

    elements = extract_ocr_text(page, timeout_seconds=17, runner=runner)

    assert invocations == [
        (
            [
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
            ],
            {
                "input": b"synthetic-png",
                "capture_output": True,
                "check": False,
                "shell": False,
                "timeout": 16.75,
            },
        )
    ]
    assert page.matrix is not None
    assert page.matrix.a == pytest.approx(200 / 72)
    assert page.matrix.d == pytest.approx(200 / 72)
    assert page.alpha is False
    assert page.colorspace is pymupdf.csRGB
    assert [element.model_dump() for element in elements] == [
        {
            "kind": "text",
            "element_id": "ocr:text:1",
            "text": "형식 중립 근거 2026",
            "x": 72.0,
            "y": 36.0,
            "width": 216.0,
            "height": 28.8,
        }
    ]


def test_ocr_caps_the_longest_raster_edge_at_4096() -> None:
    class LargeRect:
        width = 2_000.0
        height = 1_000.0

    class LargePixmap(_Pixmap):
        width = 4096
        height = 2048

    class LargePage(_Page):
        rect = LargeRect()

        def get_pixmap(
            self, *, matrix: pymupdf.Matrix, alpha: bool, colorspace: pymupdf.Colorspace
        ) -> LargePixmap:
            self.matrix = matrix
            return LargePixmap()

    page = LargePage()
    _, width, height = _rasterize(page)

    assert (width, height) == (4096, 2048)
    assert page.matrix is not None
    assert page.matrix.a == pytest.approx(4096 / 2000)


def test_ocr_missing_binary_or_model_is_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TESSDATA_PREFIX", str(tmp_path))
    monkeypatch.setattr("impromptu_ingestion.ocr.shutil.which", lambda _: None)
    with pytest.raises(StructuralExtractionError) as missing_binary:
        extract_ocr_text(_Page(), timeout_seconds=1)
    assert "binary is missing" in str(_raised(missing_binary.value))

    monkeypatch.setattr(
        "impromptu_ingestion.ocr.shutil.which", lambda _: "/usr/bin/tesseract"
    )
    with pytest.raises(StructuralExtractionError) as missing_model:
        extract_ocr_text(_Page(), timeout_seconds=1)
    assert "pinned kor model is missing" in str(_raised(missing_model.value))


def test_ocr_nonzero_exit_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    _available(monkeypatch)

    def runner(command: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(command, 7, stdout=b"", stderr=b"failed")

    with pytest.raises(StructuralExtractionError) as raised:
        extract_ocr_text(_Page(), timeout_seconds=1, runner=runner)
    assert "exited nonzero (7)" in str(_raised(raised.value))


def test_ocr_timeout_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    _available(monkeypatch)

    def runner(command: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        raise subprocess.TimeoutExpired(command, 1)

    with pytest.raises(StructuralExtractionError) as raised:
        extract_ocr_text(_Page(), timeout_seconds=1, runner=runner)
    assert "operation deadline" in str(_raised(raised.value))


@pytest.mark.parametrize("tsv", [b"", _TSV_HEADER])
def test_ocr_empty_tsv_is_unavailable(
    tsv: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    _available(monkeypatch)

    def runner(command: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(command, 0, stdout=tsv, stderr=b"")

    with pytest.raises(StructuralExtractionError) as raised:
        extract_ocr_text(_Page(), timeout_seconds=1, runner=runner)
    assert "empty TSV" in str(_raised(raised.value))


def test_ocr_encrypted_pdf_preserves_existing_rejection(tmp_path: Path) -> None:
    encrypted = tmp_path / "encrypted.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=720, height=405)
        page.insert_text((72, 72), "encrypted fixture")
        document.save(
            encrypted,
            encryption=pymupdf.PDF_ENCRYPT_AES_256,
            owner_pw="owner-password",
            user_pw="user-password",
        )

    with (
        stage_input(IngestionJob(job_id="ocr_encrypted", source=encrypted)) as source,
        pytest.raises(StructuralExtractionError) as raised,
    ):
        PdfStructuralAdapter().extract(source)
    assert raised.value.code == "encrypted_document"

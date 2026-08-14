from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from impromptu_ingestion.contracts import IngestionJob, InputKind
from impromptu_ingestion.validation import InputValidationError, validate_input


def _job(path: Path, **kwargs: object) -> IngestionJob:
    return IngestionJob(job_id="job_validation_01", source=path, **kwargs)


def _write_minimal_pptx(path: Path, *, unsafe_member: str | None = None) -> None:
    with ZipFile(path, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            (
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                '<Override PartName="/ppt/presentation.xml" '
                'ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
                "</Types>"
            ),
        )
        archive.writestr("ppt/presentation.xml", "<p:presentation />")
        if unsafe_member is not None:
            archive.writestr(unsafe_member, "must not escape")


def test_validates_pdf_signature_size_kind_and_digest(tmp_path: Path) -> None:
    source = tmp_path / "deck.pdf"
    source.write_bytes(b"%PDF-1.7\n%%EOF\n")

    validated = validate_input(_job(source))

    assert validated.kind is InputKind.PDF
    assert validated.size_bytes == source.stat().st_size
    assert len(validated.source_sha256) == 64
    assert validated.path == source.resolve()


def test_validates_minimal_safe_pptx_container(tmp_path: Path) -> None:
    source = tmp_path / "deck.pptx"
    _write_minimal_pptx(source)

    validated = validate_input(_job(source, expected_kind=InputKind.PPTX))

    assert validated.kind is InputKind.PPTX


@pytest.mark.parametrize(
    ("filename", "content", "code"),
    [
        ("deck.ppt", b"not supported", "unsupported_extension"),
        ("deck.pdf", b"not a pdf", "signature_mismatch"),
        ("deck.pptx", b"not a zip", "signature_mismatch"),
    ],
)
def test_rejects_unsupported_or_spoofed_input(
    tmp_path: Path, filename: str, content: bytes, code: str
) -> None:
    source = tmp_path / filename
    source.write_bytes(content)

    with pytest.raises(InputValidationError, match=code) as raised:
        validate_input(_job(source))

    assert raised.value.code == code


def test_rejects_expected_kind_mismatch(tmp_path: Path) -> None:
    source = tmp_path / "deck.pdf"
    source.write_bytes(b"%PDF-1.7\n%%EOF\n")

    with pytest.raises(InputValidationError) as raised:
        validate_input(_job(source, expected_kind=InputKind.PPTX))

    assert raised.value.code == "kind_mismatch"


def test_rejects_oversized_input_before_parsing(tmp_path: Path) -> None:
    source = tmp_path / "deck.pdf"
    source.write_bytes(b"%PDF-1.7\n%%EOF\n")

    with pytest.raises(InputValidationError) as raised:
        validate_input(_job(source, max_input_bytes=8))

    assert raised.value.code == "input_too_large"


def test_rejects_unsafe_ooxml_member_names(tmp_path: Path) -> None:
    source = tmp_path / "deck.pptx"
    _write_minimal_pptx(source, unsafe_member="../payload")

    with pytest.raises(InputValidationError) as raised:
        validate_input(_job(source))

    assert raised.value.code == "unsafe_archive"

"""Defensive validation at the local-file ingestion boundary."""

import hashlib
import stat
from pathlib import Path, PurePosixPath
from zipfile import BadZipFile, ZipFile

from impromptu_ingestion.contracts import IngestionJob, InputKind, ValidatedInput

_CHUNK_SIZE = 1024 * 1024
_MAX_ARCHIVE_MEMBERS = 10_000
_MAX_ARCHIVE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
_PPTX_MAIN_CONTENT_TYPE = (
    b"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
)


class InputValidationError(ValueError):
    """A safe, machine-identifiable rejection at the input boundary."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _kind_for_path(path: Path) -> InputKind:
    match path.suffix.lower():
        case ".pptx":
            return InputKind.PPTX
        case ".pdf":
            return InputKind.PDF
        case _:
            raise InputValidationError(
                "unsupported_extension", "only .pptx and .pdf inputs are supported"
            )


def _validate_regular_file(source: Path, max_input_bytes: int) -> tuple[Path, int]:
    try:
        if source.is_symlink():
            raise InputValidationError("symlink_rejected", "symbolic-link inputs are not accepted")
        metadata = source.stat()
    except FileNotFoundError as error:
        raise InputValidationError("input_not_found", "input file does not exist") from error
    except OSError as error:
        raise InputValidationError(
            "input_unreadable", "input metadata could not be read"
        ) from error

    if not stat.S_ISREG(metadata.st_mode):
        raise InputValidationError("not_regular_file", "input must be a regular file")
    if metadata.st_size <= 0:
        raise InputValidationError("empty_input", "input file is empty")
    if metadata.st_size > max_input_bytes:
        raise InputValidationError(
            "input_too_large", f"input exceeds the configured {max_input_bytes}-byte limit"
        )
    return source.resolve(strict=True), metadata.st_size


def _read_signature(path: Path) -> bytes:
    try:
        with path.open("rb") as source:
            return source.read(8)
    except OSError as error:
        raise InputValidationError("input_unreadable", "input file could not be read") from error


def _validate_signature(path: Path, kind: InputKind) -> None:
    signature = _read_signature(path)
    valid = signature.startswith(b"%PDF-") if kind is InputKind.PDF else signature.startswith(b"PK")
    if not valid:
        raise InputValidationError("signature_mismatch", f"content does not match .{kind.value}")


def _member_name_is_safe(name: str) -> bool:
    if not name or "\\" in name or "\x00" in name:
        return False
    path = PurePosixPath(name)
    return not path.is_absolute() and ".." not in path.parts and ":" not in path.parts[0]


def _validate_pptx_container(path: Path) -> None:
    try:
        with ZipFile(path) as archive:
            members = archive.infolist()
            if len(members) > _MAX_ARCHIVE_MEMBERS:
                raise InputValidationError("unsafe_archive", "OOXML archive has too many members")

            total_uncompressed = 0
            names: set[str] = set()
            for member in members:
                if not _member_name_is_safe(member.filename) or member.flag_bits & 0x1:
                    raise InputValidationError(
                        "unsafe_archive", "OOXML archive contains an unsafe or encrypted member"
                    )
                total_uncompressed += member.file_size
                if total_uncompressed > _MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                    raise InputValidationError(
                        "unsafe_archive", "OOXML expanded size exceeds the safety limit"
                    )
                names.add(member.filename)

            required = {"[Content_Types].xml", "ppt/presentation.xml"}
            if not required.issubset(names):
                raise InputValidationError(
                    "invalid_pptx", "OOXML container is missing presentation parts"
                )
            content_types = archive.read("[Content_Types].xml")
            if _PPTX_MAIN_CONTENT_TYPE not in content_types:
                raise InputValidationError(
                    "invalid_pptx", "OOXML container is not a PPTX presentation"
                )
            if archive.testzip() is not None:
                raise InputValidationError("invalid_pptx", "OOXML member checksum failed")
    except InputValidationError:
        raise
    except (BadZipFile, OSError, RuntimeError) as error:
        raise InputValidationError("invalid_pptx", "PPTX container could not be read") from error


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            while chunk := source.read(_CHUNK_SIZE):
                digest.update(chunk)
    except OSError as error:
        raise InputValidationError("input_unreadable", "input file could not be hashed") from error
    return digest.hexdigest()


def validate_input(job: IngestionJob) -> ValidatedInput:
    """Validate and fingerprint a supported local presentation input."""
    kind = _kind_for_path(job.source)
    if job.expected_kind is not None and job.expected_kind is not kind:
        raise InputValidationError(
            "kind_mismatch", f"expected {job.expected_kind.value}, received {kind.value}"
        )

    path, size_bytes = _validate_regular_file(job.source, job.max_input_bytes)
    _validate_signature(path, kind)
    if kind is InputKind.PPTX:
        _validate_pptx_container(path)

    return ValidatedInput(
        path=path,
        kind=kind,
        size_bytes=size_bytes,
        source_sha256=_sha256_file(path),
    )

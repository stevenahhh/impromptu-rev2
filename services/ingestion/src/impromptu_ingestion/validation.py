"""Defensive staging and validation at the local-file ingestion boundary."""

import hashlib
import os
import stat
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import BinaryIO
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from impromptu_ingestion.contracts import IngestionJob, InputKind, ValidatedInput

_CHUNK_SIZE = 1024 * 1024
_MAX_ARCHIVE_MEMBERS = 10_000
_MAX_ARCHIVE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
_PPTX_MAIN_CONTENT_TYPE = (
    b"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
)
_MAX_RELS_BYTES = 1024 * 1024
_ACTIVE_PPTX_PATH_SEGMENTS = frozenset({"activex"})
_ACTIVE_PPTX_BASENAMES = frozenset({"vbaproject.bin", "vbaprojectsignature.bin"})
_PDF_ACTIVE_TOKENS = (b"/JavaScript", b"/OpenAction", b"/Launch", b"/EmbeddedFiles")


class InputValidationError(ValueError):
    """A safe, machine-identifiable rejection at the input boundary."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


@dataclass(frozen=True)
class _FileIdentity:
    device: int
    inode: int
    size: int
    modified_ns: int


@dataclass(frozen=True)
class _StagedCopy:
    opened_identity: _FileIdentity
    final_identity: _FileIdentity
    size: int
    sha256: str


def _identity(metadata: os.stat_result) -> _FileIdentity:
    return _FileIdentity(
        device=metadata.st_dev,
        inode=metadata.st_ino,
        size=metadata.st_size,
        modified_ns=metadata.st_mtime_ns,
    )


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


def _initial_identity(source: Path, max_input_bytes: int) -> _FileIdentity:
    try:
        metadata = source.lstat()
    except FileNotFoundError as error:
        raise InputValidationError("input_not_found", "input file does not exist") from error
    except OSError as error:
        raise InputValidationError(
            "input_unreadable", "input metadata could not be read"
        ) from error

    if stat.S_ISLNK(metadata.st_mode):
        raise InputValidationError("symlink_rejected", "symbolic-link inputs are not accepted")
    if not stat.S_ISREG(metadata.st_mode):
        raise InputValidationError("not_regular_file", "input must be a regular file")
    if metadata.st_size <= 0:
        raise InputValidationError("empty_input", "input file is empty")
    if metadata.st_size > max_input_bytes:
        raise InputValidationError(
            "input_too_large", f"input exceeds the configured {max_input_bytes}-byte limit"
        )
    return _identity(metadata)


def _copy_stream(source: BinaryIO, destination: BinaryIO, max_input_bytes: int) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    while chunk := source.read(_CHUNK_SIZE):
        size += len(chunk)
        if size > max_input_bytes:
            raise InputValidationError(
                "input_too_large", f"input exceeds the configured {max_input_bytes}-byte limit"
            )
        destination.write(chunk)
        digest.update(chunk)
    return size, digest.hexdigest()


def _copy_source_to_stage(source_path: Path, staged_path: Path, limit: int) -> _StagedCopy:
    try:
        with source_path.open("rb") as source, staged_path.open("xb") as destination:
            opened_identity = _identity(os.fstat(source.fileno()))
            size, digest = _copy_stream(source, destination, limit)
            final_identity = _identity(os.fstat(source.fileno()))
            destination.flush()
            os.fsync(destination.fileno())
    except InputValidationError:
        raise
    except OSError as error:
        raise InputValidationError("input_unreadable", "input file could not be staged") from error
    return _StagedCopy(
        opened_identity=opened_identity,
        final_identity=final_identity,
        size=size,
        sha256=digest,
    )


def _post_copy_identity(source: Path) -> _FileIdentity:
    try:
        metadata = source.lstat()
    except OSError as error:
        raise InputValidationError(
            "source_replaced", "source changed or disappeared while it was staged"
        ) from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise InputValidationError("source_replaced", "source was replaced while it was staged")
    return _identity(metadata)


def _read_signature(path: Path) -> bytes:
    try:
        with path.open("rb") as source:
            return source.read(8)
    except OSError as error:
        raise InputValidationError("input_unreadable", "staged input could not be read") from error


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


def _validate_pptx_active_content(path: Path) -> None:
    """Reject VBA, ActiveX, and embedded OLE parts and external relationships."""
    try:
        with ZipFile(path) as archive:
            for member in archive.infolist():
                lowered = member.filename.lower()
                parts = lowered.split("/")
                if (
                    parts[-1] in _ACTIVE_PPTX_BASENAMES
                    or (parts[-1].startswith("oleobject") and parts[-1].endswith(".bin"))
                    or any(part in _ACTIVE_PPTX_PATH_SEGMENTS for part in parts)
                ):
                    raise InputValidationError(
                        "active_content",
                        f"PPTX part {member.filename!r} is active content",
                    )
                if not lowered.endswith(".rels"):
                    continue
                if member.file_size > _MAX_RELS_BYTES:
                    raise InputValidationError(
                        "unsafe_archive", "OOXML relationship part exceeds the size limit"
                    )
                relationship_xml = archive.read(member)
                if b"<!DOCTYPE" in relationship_xml or b"<!ENTITY" in relationship_xml:
                    raise InputValidationError(
                        "unsafe_archive",
                        "OOXML relationship part declares XML DOCTYPE or entities",
                    )
                root = ElementTree.fromstring(relationship_xml)
                for element in root.iter():
                    target_mode = element.get("TargetMode")
                    if target_mode is not None and target_mode.lower() == "external":
                        raise InputValidationError(
                            "active_content",
                            f"PPTX relationship {member.filename!r} targets external content",
                        )
    except InputValidationError:
        raise
    except (
        BadZipFile,
        OSError,
        RuntimeError,
        ElementTree.ParseError,
        ValueError,
    ) as error:
        raise InputValidationError("invalid_pptx", "PPTX container could not be read") from error


def _validate_pdf_active_content(path: Path) -> None:
    """Reject PDF JavaScript, OpenAction, Launch, and EmbeddedFiles tokens."""
    overlap = max(len(token) for token in _PDF_ACTIVE_TOKENS) - 1
    tail = b""
    try:
        with path.open("rb") as source:
            while chunk := source.read(_CHUNK_SIZE):
                window = tail + chunk
                if any(token in window for token in _PDF_ACTIVE_TOKENS):
                    raise InputValidationError(
                        "active_content", "PDF contains executable or action content"
                    )
                tail = window[-overlap:]
    except OSError as error:
        raise InputValidationError("input_unreadable", "staged input could not be read") from error


@contextmanager
def stage_input(job: IngestionJob) -> Generator[ValidatedInput]:
    """Copy one stable source snapshot to private storage and validate exactly that copy."""
    kind = _kind_for_path(job.source)
    if job.expected_kind is not None and job.expected_kind is not kind:
        raise InputValidationError(
            "kind_mismatch", f"expected {job.expected_kind.value}, received {kind.value}"
        )

    initial_identity = _initial_identity(job.source, job.max_input_bytes)
    with TemporaryDirectory(prefix="impromptu-ingestion-") as temporary_directory:
        directory = Path(temporary_directory)
        directory.chmod(stat.S_IRWXU)
        staged_path = directory / f"input.{kind.value}"
        copied = _copy_source_to_stage(job.source, staged_path, job.max_input_bytes)
        final_path_identity = _post_copy_identity(job.source)
        if not (
            initial_identity
            == copied.opened_identity
            == copied.final_identity
            == final_path_identity
        ):
            raise InputValidationError(
                "source_replaced", "source was modified or replaced while it was staged"
            )
        if copied.size <= 0:
            raise InputValidationError("empty_input", "input file is empty")

        _validate_signature(staged_path, kind)
        if kind is InputKind.PPTX:
            _validate_pptx_container(staged_path)
            _validate_pptx_active_content(staged_path)
        else:
            _validate_pdf_active_content(staged_path)
        staged_path.chmod(stat.S_IRUSR)

        yield ValidatedInput(
            path=staged_path,
            kind=kind,
            size_bytes=copied.size,
            source_sha256=copied.sha256,
            limits=job.limits,
        )

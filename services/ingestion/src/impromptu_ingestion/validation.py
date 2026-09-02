"""Defensive staging at the local-file ingestion boundary.

Copy identity, signature validation, and orchestration live here; OOXML package
checks live in ``pptx_container``, PDF active-content scanning in
``pdf_active_content``, and the rejection type in ``rejection``.
"""

import hashlib
import os
import stat
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import BinaryIO

from impromptu_ingestion.contracts import IngestionJob, InputKind, ValidatedInput
from impromptu_ingestion.pdf_active_content import scan_pdf_active_content
from impromptu_ingestion.pptx_container import (
    validate_pptx_active_content,
    validate_pptx_container,
)
from impromptu_ingestion.rejection import InputValidationError

_CHUNK_SIZE = 1024 * 1024


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


def _initial_identity(source: Path, max_input_bytes: int | None) -> _FileIdentity:
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
    if max_input_bytes is not None and metadata.st_size > max_input_bytes:
        raise InputValidationError(
            "input_too_large", f"input exceeds the configured {max_input_bytes}-byte limit"
        )
    return _identity(metadata)


def _copy_stream(
    source: BinaryIO, destination: BinaryIO, max_input_bytes: int | None
) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    while chunk := source.read(_CHUNK_SIZE):
        size += len(chunk)
        if max_input_bytes is not None and size > max_input_bytes:
            raise InputValidationError(
                "input_too_large", f"input exceeds the configured {max_input_bytes}-byte limit"
            )
        destination.write(chunk)
        digest.update(chunk)
    return size, digest.hexdigest()


def _copy_source_to_stage(source_path: Path, staged_path: Path, limit: int | None) -> _StagedCopy:
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
            validate_pptx_container(staged_path)
            validate_pptx_active_content(staged_path)
        else:
            scan_pdf_active_content(staged_path)
        staged_path.chmod(stat.S_IRUSR)

        yield ValidatedInput(
            path=staged_path,
            kind=kind,
            size_bytes=copied.size,
            source_sha256=copied.sha256,
            limits=job.limits,
        )

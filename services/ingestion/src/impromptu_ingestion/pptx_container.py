"""OOXML package checks: member-name safety, container integrity, active-content rejection."""

from pathlib import Path, PurePosixPath
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from impromptu_ingestion.rejection import InputValidationError

_MAX_ARCHIVE_MEMBERS = 10_000
_MAX_ARCHIVE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
_PPTX_MAIN_CONTENT_TYPE = (
    b"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
)
_MAX_RELS_BYTES = 1024 * 1024
_ACTIVE_PPTX_PATH_SEGMENTS = frozenset({"activex"})
_ACTIVE_PPTX_BASENAMES = frozenset({"vbaproject.bin", "vbaprojectsignature.bin"})


def _member_name_is_safe(name: str) -> bool:
    if not name or "\\" in name or "\x00" in name:
        return False
    path = PurePosixPath(name)
    return not path.is_absolute() and ".." not in path.parts and ":" not in path.parts[0]


def validate_pptx_container(path: Path) -> None:
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


def validate_pptx_active_content(path: Path) -> None:
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

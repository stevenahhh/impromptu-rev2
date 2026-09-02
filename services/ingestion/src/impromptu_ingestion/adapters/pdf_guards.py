"""Strict untrusted-input guards for PDF ingestion.

Every check here is load-bearing: they reject malformed, hostile, or
resource-exhausting PDFs before MuPDF parsing proceeds and cap accumulation
while pages are read. Do not weaken without an adversarial regression.
"""

import re
from typing import Protocol, cast

import pymupdf

from impromptu_ingestion.adapters.base import StructuralExtractionError

_PDF_TRAILER_BYTES = 65_536


def validate_strict_trailer(content: bytes) -> None:
    trailer = content[-_PDF_TRAILER_BYTES:]
    if b"startxref" not in trailer:
        raise StructuralExtractionError("invalid_document", "PDF has no final cross-reference")
    match = re.search(rb"startxref\s+(\d+)\s+%%EOF\s*\Z", trailer)
    if match is None:
        raise StructuralExtractionError(
            "repair_required", "PDF final cross-reference or EOF marker is incomplete"
        )

    offset = int(match.group(1))
    if offset <= 0 or offset >= len(content):
        raise StructuralExtractionError("repair_required", "PDF cross-reference offset is invalid")
    cross_reference = content[offset : offset + 2_048]
    traditional = cross_reference.startswith(b"xref")
    xref_stream = bool(
        re.match(rb"\d+\s+\d+\s+obj\b", cross_reference)
        and re.search(rb"/Type\s*/XRef\b", cross_reference)
    )
    if not traditional and not xref_stream:
        raise StructuralExtractionError(
            "repair_required", "PDF final cross-reference target is invalid"
        )


class MuPdfTools(Protocol):
    def mupdf_warnings(self, reset: int = 1) -> str: ...


def mupdf_tools() -> MuPdfTools:
    """Narrow the PyMuPDF global tools surface to the diagnostics call."""
    return cast(MuPdfTools, pymupdf.TOOLS)


def raise_if_mupdf_warned(tools: MuPdfTools) -> None:
    if tools.mupdf_warnings(reset=1).strip():
        raise StructuralExtractionError(
            "repair_required", "MuPDF reported format or repair diagnostics"
        )


def check_limit(actual: int, maximum: int, resource: str) -> None:
    if actual > maximum:
        raise StructuralExtractionError(
            "resource_limit", f"PDF {resource} exceeds the configured limit"
        )

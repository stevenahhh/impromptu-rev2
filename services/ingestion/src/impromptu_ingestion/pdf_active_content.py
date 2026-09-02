"""Chunked scan of staged PDF bytes for executable or action content."""

from pathlib import Path

from impromptu_ingestion.rejection import InputValidationError

_CHUNK_SIZE = 1024 * 1024
_PDF_ACTIVE_TOKENS = (b"/JavaScript", b"/OpenAction", b"/Launch", b"/EmbeddedFiles")


def scan_pdf_active_content(path: Path) -> None:
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

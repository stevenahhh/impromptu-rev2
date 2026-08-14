"""Private bounded-process entry point for strict PDF extraction."""

import sys

from pydantic import ValidationError

from impromptu_ingestion.adapters.base import StructuralExtractionError
from impromptu_ingestion.adapters.pdf import extract_pdf_in_process
from impromptu_ingestion.contracts import PdfWorkerFailure, PdfWorkerSuccess, ValidatedInput


def _write_response(response: PdfWorkerSuccess | PdfWorkerFailure) -> None:
    sys.stdout.buffer.write(response.model_dump_json().encode("utf-8") + b"\n")


def main() -> int:
    try:
        source = ValidatedInput.model_validate_json(sys.stdin.buffer.read())
    except ValidationError:
        _write_response(
            PdfWorkerFailure(
                code="invalid_worker_request",
                message="PDF worker request did not match its closed contract",
            )
        )
        return 0

    try:
        manifest = extract_pdf_in_process(source)
    except StructuralExtractionError as error:
        _write_response(PdfWorkerFailure(code=error.code, message=str(error)))
        return 0

    _write_response(PdfWorkerSuccess(manifest=manifest))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

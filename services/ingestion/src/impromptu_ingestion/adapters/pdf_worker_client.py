"""Bounded subprocess boundary around the isolated PDF extraction worker."""

import subprocess
import sys

from pydantic import TypeAdapter, ValidationError

from impromptu_ingestion.adapters.base import StructuralExtractionError
from impromptu_ingestion.contracts import (
    DeckManifest,
    PdfWorkerFailure,
    PdfWorkerSuccess,
    ValidatedInput,
)
from impromptu_ingestion.vision import vision_config

# Configuring a vision model is an explicit operator opt-in to server-side model
# latency, so the operation budget grows by this allowance on top of the locally
# measured OCR deadline; without configuration nothing changes.
VISION_OPERATION_ALLOWANCE_SECONDS = 150.0

_PDF_WORKER_RESPONSE = TypeAdapter[PdfWorkerSuccess | PdfWorkerFailure](
    PdfWorkerSuccess | PdfWorkerFailure
)


def run_bounded_worker(source: ValidatedInput) -> DeckManifest:
    command = [sys.executable, "-m", "impromptu_ingestion.pdf_worker"]
    budget_seconds = source.limits.operation_timeout_seconds + (
        VISION_OPERATION_ALLOWANCE_SECONDS if vision_config() is not None else 0.0
    )
    try:
        completed = subprocess.run(
            command,
            input=source.model_dump_json().encode("utf-8"),
            capture_output=True,
            check=False,
            timeout=budget_seconds,
        )
    except subprocess.TimeoutExpired as error:
        raise StructuralExtractionError(
            "operation_timeout", "PDF extraction exceeded its operation deadline"
        ) from error
    except OSError as error:
        raise StructuralExtractionError(
            "worker_unavailable", "PDF extraction worker could not be started"
        ) from error

    if completed.returncode != 0:
        raise StructuralExtractionError(
            "worker_failed", "PDF extraction worker exited unexpectedly"
        )
    try:
        response = _PDF_WORKER_RESPONSE.validate_json(completed.stdout)
    except ValidationError as error:
        raise StructuralExtractionError(
            "worker_failed", "PDF extraction worker returned an invalid response"
        ) from error
    if isinstance(response, PdfWorkerFailure):
        raise StructuralExtractionError(response.code, response.message)
    return response.manifest

"""Synchronous server/local-admin ingestion worker orchestration."""

from impromptu_ingestion.adapters import PdfStructuralAdapter, PptxStructuralAdapter
from impromptu_ingestion.canonical import manifest_sha256
from impromptu_ingestion.contracts import CompletedIngestion, IngestionJob, InputKind
from impromptu_ingestion.validation import validate_input


def ingest(job: IngestionJob) -> CompletedIngestion:
    """Validate, structurally extract, and fingerprint one local ingestion job."""
    source = validate_input(job)
    match source.kind:
        case InputKind.PPTX:
            manifest = PptxStructuralAdapter().extract(source)
        case InputKind.PDF:
            manifest = PdfStructuralAdapter().extract(source)

    return CompletedIngestion(
        job_id=job.job_id,
        manifest_hash=manifest_sha256(manifest),
        manifest=manifest,
    )

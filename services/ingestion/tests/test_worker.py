from pathlib import Path

from impromptu_ingestion.canonical import manifest_sha256
from impromptu_ingestion.contracts import IngestionJob, InputKind
from impromptu_ingestion.worker import ingest


def test_worker_validates_dispatches_and_returns_typed_result(sample_pdf: Path) -> None:
    result = ingest(
        IngestionJob(
            job_id="job_worker_01",
            source=sample_pdf,
            expected_kind=InputKind.PDF,
        )
    )

    assert result.status == "completed"
    assert result.job_id == "job_worker_01"
    assert result.manifest_hash == manifest_sha256(result.manifest)
    assert result.manifest.source_kind is InputKind.PDF

from pathlib import Path

import pytest
from pydantic import ValidationError

from impromptu_ingestion.contracts import IngestionJob, InputKind, RenderBoundary


def test_job_contract_rejects_untrusted_identifiers_and_relative_sources() -> None:
    with pytest.raises(ValidationError):
        IngestionJob(job_id="../../escape", source=Path("deck.pptx"))


def test_job_contract_accepts_an_absolute_local_source(tmp_path: Path) -> None:
    source = tmp_path / "deck.pptx"

    job = IngestionJob(job_id="job_01J9Z6Y3A2", source=source, expected_kind=InputKind.PPTX)

    assert job.source == source
    assert job.expected_kind is InputKind.PPTX


def test_render_boundary_is_explicitly_structural_only() -> None:
    boundary = RenderBoundary.structural_only()

    assert boundary.status == "not_performed"
    assert boundary.renderer is None
    assert boundary.fidelity_verified is False

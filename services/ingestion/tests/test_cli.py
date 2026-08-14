import json
from pathlib import Path

import pytest

from impromptu_ingestion.cli import main


def test_root_help_lists_worker_commands(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        main(["--help"])

    assert raised.value.code == 0
    output = capsys.readouterr().out
    assert "doctor" in output
    assert "ingest" in output
    assert "server/local-admin" in output


def test_doctor_json_reports_runtime_and_explicit_boundaries(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["doctor", "--json"]) == 0

    report = json.loads(capsys.readouterr().out)
    assert report["ok"] is True
    assert report["python"]["required"] == ">=3.14,<3.15"
    assert report["python"]["supported"] is True
    assert report["structural_extractors"] == {"pdf": True, "pptx": True}
    assert report["rendering"]["status"] == "not_configured"
    assert report["rendering"]["fidelity_verified"] is False
    assert report["ai_enabled"] is False


def test_ingest_cli_writes_a_content_addressed_manifest(
    sample_pdf: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    output = tmp_path / "manifest.json"

    assert (
        main(
            [
                "ingest",
                str(sample_pdf),
                "--job-id",
                "job_cli_01",
                "--output",
                str(output),
            ]
        )
        == 0
    )

    envelope = json.loads(output.read_text(encoding="utf-8"))
    assert envelope["job_id"] == "job_cli_01"
    assert envelope["status"] == "completed"
    assert len(envelope["manifest_hash"]) == 64
    assert envelope["manifest"]["source_kind"] == "pdf"
    assert envelope["manifest"]["render_boundary"]["status"] == "not_performed"
    assert "completed" in capsys.readouterr().out


def test_ingest_cli_does_not_overwrite_an_existing_output(
    sample_pdf: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    output = tmp_path / "manifest.json"
    output.write_text("keep", encoding="utf-8")

    exit_code = main(["ingest", str(sample_pdf), "--output", str(output)])

    assert exit_code == 2
    assert output.read_text(encoding="utf-8") == "keep"
    assert "output_exists" in capsys.readouterr().err

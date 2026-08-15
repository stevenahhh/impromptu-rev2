import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

import impromptu_ingestion.cli as cli
from impromptu_ingestion.cli import main


def test_installed_impromptu_ingestion_executable_has_cli_contract() -> None:
    executable = shutil.which("impromptu-ingestion")

    assert executable is not None
    completed = subprocess.run(
        [executable, "--help"],
        capture_output=True,
        check=False,
        text=True,
        timeout=10,
    )

    assert completed.returncode == 0
    assert completed.stderr == ""
    assert completed.stdout.startswith("usage: impromptu-ingestion")


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
    rendering = report["rendering"]
    from impromptu_ingestion.render.libreoffice import discover_soffice

    expected = "configured" if discover_soffice() is not None else "not_configured"
    assert rendering["status"] == expected
    assert (rendering["renderer"] is not None) is (expected == "configured")
    assert rendering["fidelity_verified"] is False
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


def test_output_temp_is_flushed_and_fsynced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "temp"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    fsynced: list[int] = []
    real_fsync = cli.os.fsync

    def record_fsync(descriptor: int) -> None:
        fsynced.append(descriptor)
        real_fsync(descriptor)

    monkeypatch.setattr(cli.os, "fsync", record_fsync)

    try:
        cli._write_and_sync(descriptor, b"complete")
    finally:
        os.close(descriptor)

    assert path.read_bytes() == b"complete"
    assert len(fsynced) == 1


def test_interrupted_output_is_cleaned_and_retry_publishes_complete_result(
    sample_pdf: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    output = tmp_path / "manifest.json"
    real_write = cli._write_and_sync

    def interrupt_after_partial_write(descriptor: int, payload: bytes) -> None:
        os.write(descriptor, payload[:7])
        raise KeyboardInterrupt

    with monkeypatch.context() as patch:
        patch.setattr(cli, "_write_and_sync", interrupt_after_partial_write)
        with pytest.raises(KeyboardInterrupt):
            main(["ingest", str(sample_pdf), "--output", str(output)])

    assert not output.exists()
    assert list(tmp_path.glob(".manifest.json.*.tmp")) == []

    assert main(["ingest", str(sample_pdf), "--output", str(output)]) == 0
    assert json.loads(output.read_text(encoding="utf-8"))["status"] == "completed"
    assert list(tmp_path.glob(".manifest.json.*.tmp")) == []
    assert real_write is cli._write_and_sync
    capsys.readouterr()


def test_cancelled_output_cleans_unique_sibling_temp(
    sample_pdf: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Cancelled(BaseException):
        pass

    output = tmp_path / "manifest.json"

    def cancel(descriptor: int, payload: bytes) -> None:
        os.write(descriptor, payload[:1])
        raise Cancelled

    monkeypatch.setattr(cli, "_write_and_sync", cancel)

    with pytest.raises(Cancelled):
        main(["ingest", str(sample_pdf), "--output", str(output)])

    assert not output.exists()
    assert list(tmp_path.glob(".manifest.json.*.tmp")) == []


def test_hardlink_substitution_cannot_publish_or_modify_victim(
    sample_pdf: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    output = tmp_path / "manifest.json"
    victim = tmp_path / "victim.txt"
    victim.write_bytes(b"must remain unchanged")
    original_links = victim.stat().st_nlink
    attacker_link = tmp_path / "attacker-link"
    captured_temporary: list[Path] = []
    real_mkstemp = cli.mkstemp
    real_write = cli._write_and_sync

    def capture_mkstemp(*, dir: Path, prefix: str, suffix: str) -> tuple[int, str]:
        descriptor, name = real_mkstemp(dir=dir, prefix=prefix, suffix=suffix)
        captured_temporary.append(Path(name))
        return descriptor, name

    def substitute_after_descriptor_write(descriptor: int, payload: bytes) -> None:
        real_write(descriptor, payload)
        temporary = captured_temporary[0]
        try:
            temporary.unlink()
        except PermissionError:
            os.link(temporary, attacker_link)
        else:
            os.link(victim, temporary)

    monkeypatch.setattr(cli, "mkstemp", capture_mkstemp)
    monkeypatch.setattr(cli, "_write_and_sync", substitute_after_descriptor_write)

    try:
        assert main(["ingest", str(sample_pdf), "--output", str(output)]) == 2
    finally:
        attacker_link.unlink(missing_ok=True)
    assert victim.read_bytes() == b"must remain unchanged"
    assert victim.stat().st_nlink == original_links
    assert not output.exists()
    assert list(tmp_path.glob(".manifest.json.*.tmp")) == []
    assert "output_tampered" in capsys.readouterr().err


def test_preexisting_output_symlink_cannot_redirect_publication(
    sample_pdf: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    output = tmp_path / "manifest.json"
    victim = tmp_path / "victim.txt"
    victim.write_bytes(b"must remain unchanged")
    output.symlink_to(victim)

    assert main(["ingest", str(sample_pdf), "--output", str(output)]) == 2
    assert output.is_symlink()
    assert victim.read_bytes() == b"must remain unchanged"
    assert list(tmp_path.glob(".manifest.json.*.tmp")) == []
    assert "output_exists" in capsys.readouterr().err


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
    assert list(tmp_path.glob(".manifest.json.*.tmp")) == []
    assert "output_exists" in capsys.readouterr().err

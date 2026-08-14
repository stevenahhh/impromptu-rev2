"""Command-line surface for the server/local-admin ingestion worker."""

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import cast

from pydantic import ValidationError

from impromptu_ingestion.adapters import StructuralExtractionError
from impromptu_ingestion.contracts import CompletedIngestion, IngestionJob
from impromptu_ingestion.doctor import doctor_report
from impromptu_ingestion.validation import InputValidationError
from impromptu_ingestion.worker import ingest


class CliOperationError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="impromptu-ingestion",
        description="Structural PPTX/PDF ingestion for a server/local-admin worker.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    doctor = commands.add_parser("doctor", help="report extractor readiness and boundaries")
    doctor.add_argument("--json", action="store_true", help="emit a machine-readable report")

    ingest_command = commands.add_parser("ingest", help="validate and structurally extract a deck")
    ingest_command.add_argument("source", help="local .pptx or .pdf input")
    ingest_command.add_argument(
        "--job-id", default="local_ingest", help="safe worker job identifier"
    )
    ingest_command.add_argument(
        "--output",
        required=True,
        help="new JSON output path; existing files are never overwritten",
    )
    return parser


def _json_bytes(value: object) -> bytes:
    return (
        json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        + b"\n"
    )


def _absolute_without_resolving(path: Path) -> Path:
    return path if path.is_absolute() else Path.cwd() / path


def _write_new_output(path: Path, result: CompletedIngestion) -> None:
    output = _absolute_without_resolving(path)
    try:
        with output.open("xb") as stream:
            stream.write(_json_bytes(result.model_dump(mode="json")))
    except FileExistsError as error:
        raise CliOperationError("output_exists", "refusing to overwrite existing output") from error
    except OSError as error:
        raise CliOperationError("output_unwritable", "output file could not be written") from error


def _run_doctor(as_json: bool) -> int:
    report = doctor_report()
    if as_json:
        print(_json_bytes(report.model_dump(mode="json")).decode("utf-8"), end="")
    else:
        state = "ready" if report.ok else "not ready"
        print(f"ingestion worker: {state}")
        print("rendering: not configured (structural extraction only)")
        print("AI/OCR/VLM: disabled")
    return 0 if report.ok else 1


def _run_ingest(source_argument: str, job_id: str, output_argument: str) -> int:
    source = _absolute_without_resolving(Path(source_argument))
    result = ingest(IngestionJob(job_id=job_id, source=source))
    _write_new_output(Path(output_argument), result)
    print(f"completed {result.job_id}: {result.manifest_hash}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """Run the CLI and return a process exit code."""
    arguments = _parser().parse_args(argv)
    command = cast(str, arguments.command)
    try:
        if command == "doctor":
            return _run_doctor(cast(bool, arguments.json))
        return _run_ingest(
            cast(str, arguments.source),
            cast(str, arguments.job_id),
            cast(str, arguments.output),
        )
    except (InputValidationError, StructuralExtractionError, CliOperationError) as error:
        print(f"error[{error.code}]: {error}", file=sys.stderr)
        return 2
    except ValidationError as error:
        print(f"error[invalid_job]: {error}", file=sys.stderr)
        return 2

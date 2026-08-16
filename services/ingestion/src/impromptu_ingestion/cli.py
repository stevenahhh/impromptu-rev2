"""Command-line surface for the server/local-admin ingestion worker."""

import argparse
import json
import os
import stat
import sys
from collections.abc import Sequence
from pathlib import Path
from tempfile import mkstemp
from typing import cast

from pydantic import ValidationError

from impromptu_ingestion.adapters import StructuralExtractionError
from impromptu_ingestion.contracts import CompletedIngestion, IngestionJob
from impromptu_ingestion.doctor import doctor_report
from impromptu_ingestion.render.assets import AssetExternalizationError, FontExtractionError
from impromptu_ingestion.render.libreoffice import (
    LibreOfficeConversionError,
    LibreOfficeSvgConverter,
    converter_version,
    discover_soffice,
)
from impromptu_ingestion.render.pdf import render_pdf_pages
from impromptu_ingestion.render.pipeline import RenderError, RenderRequest, render_deck
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

    render_command = commands.add_parser(
        "render", help="render a deck to per-slide SVG, assets, and animation timelines"
    )
    render_command.add_argument("source", help="local .pptx or .pdf input")
    render_command.add_argument(
        "--output-dir",
        required=True,
        help="new or empty output directory; existing contents are never replaced",
    )
    render_command.add_argument(
        "--allow-mapping-mismatch",
        action="store_true",
        help=(
            "publish a static-only render when the deck's shapes do not mirror the rendered "
            "output; animation stays withheld and every disagreement is recorded"
        ),
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


def _write_and_sync(descriptor: int, payload: bytes) -> None:
    remaining = memoryview(payload)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise OSError("output write made no progress")
        remaining = remaining[written:]
    os.fsync(descriptor)


def _same_file(left: os.stat_result, right: os.stat_result) -> bool:
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def _verify_temporary_identity(descriptor: int, temporary: Path) -> os.stat_result:
    descriptor_status = os.fstat(descriptor)
    try:
        path_status = temporary.lstat()
    except OSError as error:
        raise CliOperationError(
            "output_tampered", "output temporary path disappeared before publication"
        ) from error

    if (
        not stat.S_ISREG(descriptor_status.st_mode)
        or not stat.S_ISREG(path_status.st_mode)
        or not _same_file(descriptor_status, path_status)
        or descriptor_status.st_nlink != 1
        or path_status.st_nlink != 1
    ):
        raise CliOperationError(
            "output_tampered", "output temporary path identity or link count changed"
        )
    return descriptor_status


def _verify_published_identity(
    descriptor: int, output: Path, expected_links: int
) -> os.stat_result:
    descriptor_status = os.fstat(descriptor)
    try:
        output_status = output.lstat()
    except OSError as error:
        raise CliOperationError("output_tampered", "published output path disappeared") from error
    if (
        not stat.S_ISREG(output_status.st_mode)
        or not _same_file(descriptor_status, output_status)
        or descriptor_status.st_nlink != expected_links
        or output_status.st_nlink != expected_links
    ):
        raise CliOperationError(
            "output_tampered", "published output identity or link count changed"
        )
    return descriptor_status


def _unlink_if_same_file(path: Path, identity: os.stat_result) -> None:
    try:
        current = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISREG(current.st_mode) and _same_file(current, identity):
        path.unlink()


def _publish_no_replace(descriptor: int, temporary: Path, output: Path) -> os.stat_result:
    identity = _verify_temporary_identity(descriptor, temporary)
    try:
        os.link(temporary, output, follow_symlinks=False)
    except FileExistsError as error:
        raise CliOperationError("output_exists", "refusing to overwrite existing output") from error
    except OSError as error:
        raise CliOperationError(
            "output_unwritable", "output file could not be atomically published"
        ) from error

    try:
        return _verify_published_identity(descriptor, output, expected_links=2)
    except BaseException:
        _unlink_if_same_file(output, identity)
        raise


def _verify_completed_output(output: Path, identity: os.stat_result) -> None:
    try:
        output_status = output.lstat()
    except OSError as error:
        raise CliOperationError("output_tampered", "completed output path disappeared") from error
    if (
        not stat.S_ISREG(output_status.st_mode)
        or not _same_file(identity, output_status)
        or output_status.st_nlink != 1
    ):
        raise CliOperationError(
            "output_tampered", "completed output identity or link count changed"
        )


def _write_new_output(path: Path, result: CompletedIngestion) -> None:
    output = _absolute_without_resolving(path)
    try:
        descriptor, temporary_name = mkstemp(
            dir=output.parent,
            prefix=f".{output.name}.",
            suffix=".tmp",
        )
    except OSError as error:
        raise CliOperationError(
            "output_unwritable", "output temporary file could not be created"
        ) from error

    temporary = Path(temporary_name)
    published_identity: os.stat_result | None = None
    try:
        try:
            _write_and_sync(descriptor, _json_bytes(result.model_dump(mode="json")))
            published_identity = _publish_no_replace(descriptor, temporary, output)
        except CliOperationError:
            raise
        except OSError as error:
            raise CliOperationError(
                "output_unwritable", "output file could not be completed"
            ) from error
    finally:
        try:
            os.close(descriptor)
        finally:
            temporary.unlink(missing_ok=True)

    _verify_completed_output(output, published_identity)


def _run_doctor(as_json: bool) -> int:
    report = doctor_report()
    if as_json:
        print(_json_bytes(report.model_dump(mode="json")).decode("utf-8"), end="")
    else:
        state = "ready" if report.ok else "not ready"
        print(f"ingestion worker: {state}")
        rendering = report.rendering
        if rendering.renderer is None:
            print("rendering: not configured (structural extraction only)")
        else:
            print(f"rendering: configured ({rendering.renderer})")
        print("AI/OCR/VLM: disabled")
    return 0 if report.ok else 1


def _run_render(
    source_argument: str, output_dir_argument: str, allow_mapping_mismatch: bool
) -> int:
    source = _absolute_without_resolving(Path(source_argument))
    output_dir = _absolute_without_resolving(Path(output_dir_argument))
    if source.suffix.lower() == ".pdf":
        rendered = render_pdf_pages(source, output_dir)
        print(f"rendered {len(rendered.slides)} static PDF pages")
        if rendered.ineligible_reason is not None:
            print(f"animation withheld: {rendered.ineligible_reason}")
        return 0
    soffice = discover_soffice()
    if soffice is None:
        raise CliOperationError(
            "renderer_not_configured",
            "LibreOffice was not found; set SOFFICE_PATH or install it to render decks",
        )
    rendered = render_deck(
        RenderRequest(
            source=source,
            output_dir=output_dir,
            converter=LibreOfficeSvgConverter(soffice),
            renderer_version=converter_version(soffice),
            strict_mapping=not allow_mapping_mismatch,
        )
    )
    eligibility = "animatable" if rendered.animation_eligible else "static only"
    print(
        f"rendered {len(rendered.slides)} slide(s), {len(rendered.assets)} asset(s): {eligibility}"
    )
    if rendered.ineligible_reason is not None:
        print(f"animation withheld: {rendered.ineligible_reason}")
    return 0


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
        if command == "render":
            return _run_render(
                cast(str, arguments.source),
                cast(str, arguments.output_dir),
                cast(bool, arguments.allow_mapping_mismatch),
            )
        return _run_ingest(
            cast(str, arguments.source),
            cast(str, arguments.job_id),
            cast(str, arguments.output),
        )
    except (
        AssetExternalizationError,
        FontExtractionError,
        InputValidationError,
        LibreOfficeConversionError,
        RenderError,
        StructuralExtractionError,
        CliOperationError,
    ) as error:
        print(f"error[{error.code}]: {error}", file=sys.stderr)
        return 2
    except ValidationError as error:
        print(f"error[invalid_job]: {error}", file=sys.stderr)
        return 2

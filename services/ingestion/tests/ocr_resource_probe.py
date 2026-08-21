"""Run the frozen scanned page through ten sequential real OCR operations."""

import argparse
import json
import platform
import resource
import tempfile
import time
from pathlib import Path

import pymupdf

from impromptu_ingestion.contracts import IngestionJob
from impromptu_ingestion.worker import ingest

_EXPECTED_SENTINEL = "형식 중립 근거 자료 2026"


def _ten_page_copy(source_path: Path, output_path: Path) -> None:
    with pymupdf.open(source_path) as source, pymupdf.open() as target:
        for _ in range(10):
            target.insert_pdf(source)
        target.save(output_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("fixture", type=Path)
    arguments = parser.parse_args()
    fixture = arguments.fixture.resolve(strict=True)

    with tempfile.TemporaryDirectory(prefix="ocr-resource-") as temporary:
        ten_page_path = Path(temporary) / "korean-scanned-10-pages.pdf"
        _ten_page_copy(fixture, ten_page_path)
        self_before = resource.getrusage(resource.RUSAGE_SELF)
        children_before = resource.getrusage(resource.RUSAGE_CHILDREN)
        started = time.perf_counter()
        result = ingest(IngestionJob(job_id="ocr_resource_probe", source=ten_page_path))
        wall_seconds = time.perf_counter() - started
        self_after = resource.getrusage(resource.RUSAGE_SELF)
        children_after = resource.getrusage(resource.RUSAGE_CHILDREN)

    texts_by_page = [
        " ".join(element.text for element in slide.elements if element.kind == "text")
        for slide in result.manifest.slides
    ]
    warning_codes_by_page = [
        [warning.code for warning in slide.warnings] for slide in result.manifest.slides
    ]
    receipt = {
        "schemaVersion": 1,
        "hardware": {
            "machine": platform.machine(),
            "processor": platform.processor(),
            "system": platform.system(),
        },
        "fixture": str(fixture),
        "inContainerUsage": {
            "wallSeconds": round(wall_seconds, 6),
            "userSeconds": round(
                self_after.ru_utime
                - self_before.ru_utime
                + children_after.ru_utime
                - children_before.ru_utime,
                6,
            ),
            "sysSeconds": round(
                self_after.ru_stime
                - self_before.ru_stime
                + children_after.ru_stime
                - children_before.ru_stime,
                6,
            ),
            "maxRssBytes": max(self_after.ru_maxrss, children_after.ru_maxrss) * 1024,
        },
        "pageCount": len(result.manifest.slides),
        "concurrency": 1,
        "expectedSentinel": _EXPECTED_SENTINEL,
        "recognizedTexts": texts_by_page,
        "exactSentinelPages": sum(text == _EXPECTED_SENTINEL for text in texts_by_page),
        "ocrAppliedPages": sum(
            "ocr_applied" in warning_codes for warning_codes in warning_codes_by_page
        ),
        "warningCodesByPage": warning_codes_by_page,
    }
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
    if receipt["pageCount"] != 10 or receipt["ocrAppliedPages"] != 10:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

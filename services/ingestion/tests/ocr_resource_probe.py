"""Run the frozen scanned page through ten sequential real OCR operations."""

import argparse
import json
import platform
import resource
import tempfile
import time
from pathlib import Path

import pymupdf

from impromptu_ingestion.contracts import CompletedIngestion, IngestionJob
from impromptu_ingestion.worker import ingest

_EXPECTED_SENTINEL = "형식 중립 근거 자료 2026"
SLIDES_PER_SENTINEL_PAGE = 6


def _ten_page_copy(source_path: Path, output_path: Path) -> None:
    """Builds a ten-page document by cycling the fixture's slides one page at a
    time so the probe always measures exactly ten sequential OCR operations,
    independent of the fixture's slide count."""
    with pymupdf.open(source_path) as source, pymupdf.open() as target:
        slide_count = source.page_count
        for index in range(10):
            target.insert_pdf(source, from_page=index % slide_count, to_page=index % slide_count)
        target.save(output_path)


def _lines_by_page(result: CompletedIngestion) -> list[list[str]]:
    return [
        [element.text for element in slide.elements if element.kind == "text"]
        for slide in result.manifest.slides
    ]


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
    lines_by_page = _lines_by_page(result)
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
        # The dense fixture carries body text around the sentinel, so exact
        # restoration is asserted at line level: the sentinel must appear as a
        # standalone recognized line with no extra or missing characters.
        "recognizedLinesByPage": lines_by_page,
        "exactSentinelPages": sum(
            _EXPECTED_SENTINEL in lines for lines in lines_by_page
        ),
        "pagesWithAnyText": sum(bool(lines) for lines in lines_by_page),
        "ocrAppliedPages": sum(
            "ocr_applied" in warning_codes for warning_codes in warning_codes_by_page
        ),
        "warningCodesByPage": warning_codes_by_page,
    }
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
    if receipt["pageCount"] != 10 or receipt["ocrAppliedPages"] != 10:
        return 1
    # Slide one (the only sentinel-bearing slide) is replicated onto 10-page
    # copies at positions 0 and 6, so exactly those two pages must restore
    # the sentinel line verbatim.
    expected_sentinel_pages = len(range(0, receipt["pageCount"], SLIDES_PER_SENTINEL_PAGE))
    if receipt["exactSentinelPages"] != expected_sentinel_pages:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

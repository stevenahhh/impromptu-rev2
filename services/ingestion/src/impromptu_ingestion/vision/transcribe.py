"""Bounded chat-completions transcription calls and strict response validation.

The model's only job is to read the rendered page pixels and return the text
present on the page. The prompt forbids summarizing, translating, completing or
explaining, and every response must parse into a closed schema
(``{"lines": [string, ...]}``); anything else is treated as a failure so the
caller can fall back to the local Tesseract path. This module runs exclusively
inside the server-side ingestion worker; nothing here is reachable from a
browser bundle.
"""

import base64
import json
import urllib.error
import urllib.request
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import Protocol, cast

from impromptu_ingestion.contracts import TextElement
from impromptu_ingestion.vision.config import VisionConfig, vision_config
from impromptu_ingestion.vision.render import RasterizablePage, render_vision_jpeg

_MAX_CALL_SECONDS = 60.0
_MIN_CALL_SECONDS = 1.0
# Hallucination guards: real slides never approach these bounds; a response that
# does is treated as invalid and the page falls back to Tesseract.
_MAX_LINES = 200
_MAX_LINE_CHARACTERS = 500
_MAX_TOTAL_CHARACTERS = 20_000

_USER_AGENT = "impromptu-ingestion-vision/1"

SYSTEM_PROMPT = "You are an OCR engine. Transcribe exactly the text visible in the image."
TRANSCRIBE_INSTRUCTION = (
    "Transcribe all text visible on this presentation slide, top-to-bottom, one "
    "output line per visual line, exactly as written. Do not summarize, translate, "
    "complete, explain, or add anything not visible in the image. Respond only "
    'with JSON of the shape {"lines": ["...", "..."]}.'
)


class _HttpResponse(Protocol):
    def read(self) -> bytes: ...

    def __enter__(self) -> _HttpResponse: ...

    def __exit__(self, *args: object) -> None: ...


class JsonOpener(Protocol):
    def __call__(
        self, request: urllib.request.Request, *, timeout: float
    ) -> _HttpResponse: ...  # pragma: no cover


def _urlopen_bounded(request: urllib.request.Request, *, timeout: float) -> _HttpResponse:
    # Every vision call carries an explicit socket timeout so worker threads can
    # never hang past the operation deadline.
    return cast(_HttpResponse, urllib.request.urlopen(request, timeout=timeout))


@dataclass(frozen=True)
class TranscriptionJob:
    jpeg: bytes
    page_width: float
    page_height: float


def line_elements(
    lines: list[str], page_width: float, page_height: float
) -> tuple[TextElement, ...]:
    # The model returns reading-order lines without geometry, so each line is
    # anchored to the full page box; text order carries the layout information.
    return tuple(
        TextElement(
            element_id=f"vision:text:{index}",
            text=line,
            x=0.0,
            y=0.0,
            width=page_width,
            height=page_height,
        )
        for index, line in enumerate(lines, start=1)
    )


def _parse_transcription(content: str) -> list[str] | None:
    try:
        value: object = json.loads(content)
    except json.JSONDecodeError, TypeError:
        return None
    if not isinstance(value, dict):
        return None
    mapping = cast("dict[str, object]", value)
    if set(mapping) != {"lines"}:
        return None
    entries = cast("object", mapping.get("lines"))
    if not isinstance(entries, list):
        return None
    entries_by_item = cast("list[object]", entries)
    lines: list[str] = []
    total_characters = 0
    for entry in entries_by_item:
        if not isinstance(entry, str):
            return None
        line = entry.strip()
        if not line:
            continue
        total_characters += len(line)
        lines.append(line)
    if not lines or len(lines) > _MAX_LINES:
        return None
    if any(len(line) > _MAX_LINE_CHARACTERS for line in lines):
        return None
    if total_characters > _MAX_TOTAL_CHARACTERS:
        return None
    return lines


def _completion_content(body: dict[str, object]) -> str | None:
    choices_object = cast("object", body.get("choices"))
    if not isinstance(choices_object, list) or not choices_object:
        return None
    first_object = cast("object", choices_object[0])
    if not isinstance(first_object, dict):
        return None
    first = cast("dict[str, object]", first_object)
    message_object = cast("object", first.get("message"))
    if not isinstance(message_object, dict):
        return None
    message = cast("dict[str, object]", message_object)
    content = cast("object", message.get("content"))
    return content if isinstance(content, str) else None


def transcribe_jpeg(
    job: TranscriptionJob,
    *,
    config: VisionConfig,
    timeout_seconds: float,
    opener: JsonOpener = _urlopen_bounded,
) -> tuple[TextElement, ...] | None:
    payload = {
        "model": config.model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:image/jpeg;base64,"
                            + base64.b64encode(job.jpeg).decode("ascii")
                        },
                    },
                    {"type": "text", "text": TRANSCRIBE_INSTRUCTION},
                ],
            },
        ],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }
    request = urllib.request.Request(
        f"{config.base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {config.api_key}",
            "user-agent": _USER_AGENT,
        },
        method="POST",
    )
    try:
        with opener(request, timeout=timeout_seconds) as response:
            body = cast("dict[str, object]", json.loads(response.read().decode("utf-8")))
    except OSError, urllib.error.URLError, ValueError, TypeError:
        # Network- or transport-shaped failures make the page unavailable to the
        # model path; the caller falls back to local Tesseract.
        return None
    content = _completion_content(body)
    if content is None:
        return None
    lines = _parse_transcription(content)
    if lines is None:
        return None
    return line_elements(lines, job.page_width, job.page_height)


def transcribe_pages(
    jobs: Mapping[int, TranscriptionJob],
    *,
    config: VisionConfig,
    timeout_seconds: float,
    opener: JsonOpener = _urlopen_bounded,
    max_workers: int = 4,
) -> dict[int, tuple[TextElement, ...]]:
    """Transcribe pre-rendered pages concurrently under one bounded deadline."""
    if not jobs or timeout_seconds < _MIN_CALL_SECONDS:
        return {}
    call_timeout = min(timeout_seconds, _MAX_CALL_SECONDS)
    results: dict[int, tuple[TextElement, ...]] = {}
    executor = ThreadPoolExecutor(max_workers=min(max_workers, len(jobs)))
    try:
        futures = {
            executor.submit(
                transcribe_jpeg, job, config=config, timeout_seconds=call_timeout, opener=opener
            ): index
            for index, job in jobs.items()
        }
        done, pending = wait(futures, timeout=call_timeout + 5.0)
        for future in done:
            index = futures[future]
            try:
                elements = future.result()
            except Exception:
                # A worker thread must never poison the batch: its page simply
                # falls back to Tesseract like any other model failure.
                elements = None
            if elements is not None:
                results[index] = elements
        for future in pending:
            future.cancel()
    finally:
        # Never block on stragglers: their sockets are already bounded by the
        # per-call timeout, so the threads terminate on their own.
        executor.shutdown(wait=False, cancel_futures=True)
    return results


def extract_vision_text(
    page: RasterizablePage,
    *,
    timeout_seconds: float,
    opener: JsonOpener = _urlopen_bounded,
    config: VisionConfig | None = None,
) -> tuple[TextElement, ...] | None:
    """Render and transcribe one page; ``None`` means the path is unavailable."""
    resolved = config if config is not None else vision_config()
    if resolved is None:
        return None
    jpeg = render_vision_jpeg(page)
    if jpeg is None:
        return None
    return transcribe_jpeg(
        TranscriptionJob(jpeg=jpeg, page_width=page.rect.width, page_height=page.rect.height),
        config=resolved,
        timeout_seconds=timeout_seconds,
        opener=opener,
    )


# Legacy underscore spelling of ``line_elements``; referenced as
# ``impromptu_ingestion.vision._line_elements`` by the frozen test suite.
_line_elements = line_elements

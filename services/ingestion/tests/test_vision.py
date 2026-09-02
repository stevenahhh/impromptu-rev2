"""Server-side vision-model transcription for raster-only PDF pages."""

import base64
import io
import json
from typing import cast

import pytest

from impromptu_ingestion import vision
from impromptu_ingestion.contracts import TextElement

_VISION_ENV_NAMES = (
    "IMPROMPTU_VISION_MODEL_BASE_URL",
    "IMPROMPTU_VISION_MODEL_API_KEY",
    "IMPROMPTU_VISION_MODEL_NAME",
    "CHAT_MODEL_BASE_URL",
    "CHAT_MODEL_API_KEY",
    "OPENCODE_ZEN_API_KEY",
)


def _clear_vision_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in _VISION_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)


def _configure(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_vision_env(monkeypatch)
    monkeypatch.setenv("IMPROMPTU_VISION_MODEL_BASE_URL", "https://vision.example/v1")
    monkeypatch.setenv("IMPROMPTU_VISION_MODEL_API_KEY", "vision-secret")
    monkeypatch.setenv("IMPROMPTU_VISION_MODEL_NAME", "vision-model-x")


class _Rect:
    width = 720.0
    height = 360.0


class _Pixmap:
    width = 3000
    height = 1500

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def tobytes(self, output: str, **options: object) -> bytes:
        assert output == "jpg"
        return self._payload


class _Page:
    rect = _Rect()

    def __init__(self, payload: bytes = b"jpeg-bytes") -> None:
        self._payload = payload

    def get_pixmap(self, *, matrix: object, alpha: bool) -> _Pixmap:
        assert alpha is False
        return _Pixmap(self._payload)


def _completion(content: str) -> bytes:
    return json.dumps(
        {"choices": [{"index": 0, "message": {"role": "assistant", "content": content}}]}
    ).encode()


def _lines_completion(lines: list[str]) -> bytes:
    return _completion(json.dumps({"lines": lines}, ensure_ascii=False))


def _capture_opener(
    response: bytes | Exception,
    calls: list[tuple[object, float]],
) -> vision.JsonOpener:
    class _HttpResponse(io.BytesIO):
        def __enter__(self) -> _HttpResponse:
            return self

        def __exit__(self, *args: object) -> None:
            self.close()

    def opener(request: object, *, timeout: float) -> object:
        calls.append((request, timeout))
        if isinstance(response, Exception):
            raise response
        return _HttpResponse(cast(bytes, response))

    return cast(vision.JsonOpener, opener)


def test_vision_requires_full_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_vision_env(monkeypatch)

    assert vision.vision_config() is None

    monkeypatch.setenv("CHAT_MODEL_BASE_URL", "https://chat.example/v1")
    # Placeholder credentials from the development defaults never enable the path.
    monkeypatch.setenv("CHAT_MODEL_API_KEY", "local-chat-model-key-required")
    assert vision.vision_config() is None

    monkeypatch.setenv("CHAT_MODEL_API_KEY", "real-secret")
    config = vision.vision_config()
    assert config is not None
    assert config.base_url == "https://chat.example/v1"
    assert config.api_key == "real-secret"

    monkeypatch.setenv("IMPROMPTU_VISION_MODEL_BASE_URL", "https://vision.example/v1")
    monkeypatch.setenv("IMPROMPTU_VISION_MODEL_NAME", "vision-model-x")
    overridden = vision.vision_config()
    assert overridden is not None
    assert overridden.base_url == "https://vision.example/v1"
    assert overridden.model == "vision-model-x"


def test_vision_transcription_maps_lines_to_page_elements(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)
    calls: list[tuple[object, float]] = []
    opener = _capture_opener(_lines_completion(["국립순천대학교", "자려고 누웠는데 404"]), calls)

    elements = vision.extract_vision_text(_Page(), timeout_seconds=12.0, opener=opener)

    assert elements is not None
    assert [element.model_dump() for element in elements] == [
        {
            "kind": "text",
            "element_id": "vision:text:1",
            "text": "국립순천대학교",
            "x": 0.0,
            "y": 0.0,
            "width": 720.0,
            "height": 360.0,
        },
        {
            "kind": "text",
            "element_id": "vision:text:2",
            "text": "자려고 누웠는데 404",
            "x": 0.0,
            "y": 0.0,
            "width": 720.0,
            "height": 360.0,
        },
    ]

    request = calls[0][0]
    body = json.loads(cast(bytes, request.data).decode())
    assert body["model"] == "vision-model-x"
    assert body["temperature"] == 0
    assert body["response_format"] == {"type": "json_object"}
    assert body["messages"][0]["role"] == "system"
    assert body["messages"][1]["content"][0]["type"] == "image_url"
    embedded = body["messages"][1]["content"][0]["image_url"]["url"]
    assert embedded.startswith("data:image/jpeg;base64,")
    assert base64.b64decode(embedded.removeprefix("data:image/jpeg;base64,")) == (b"jpeg-bytes")
    instruction = body["messages"][1]["content"][1]["text"]
    assert "Do not summarize" in instruction
    assert calls[0][1] == pytest.approx(12.0)


@pytest.mark.parametrize(
    "content",
    [
        # Prose about the image instead of the image's text.
        "This slide shows the university title and a subtitle.",
        '{"summary": "국립순천대학교 배경 슬라이드입니다."}',
        '{"lines": "국립순천대학교"}',
        '{"lines": [42]}',
        "not json at all",
    ],
)
def test_vision_invalid_or_prose_response_is_rejected(
    monkeypatch: pytest.MonkeyPatch, content: str
) -> None:
    _configure(monkeypatch)
    opener = _capture_opener(_completion(content), [])

    assert vision.extract_vision_text(_Page(), timeout_seconds=5.0, opener=opener) is None


def test_vision_caps_hallucinated_volume(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    opener = _capture_opener(_lines_completion(["줄"] * 201), [])

    assert vision.extract_vision_text(_Page(), timeout_seconds=5.0, opener=opener) is None


def test_vision_network_failures_are_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)

    refused = _capture_opener(OSError("connection refused"), [])
    assert vision.extract_vision_text(_Page(), timeout_seconds=5.0, opener=refused) is None

    import urllib.error

    http_error = _capture_opener(
        urllib.error.HTTPError(
            "https://vision.example/v1", 503, "unavailable", {}, io.BytesIO(b"down")
        ),
        [],
    )
    assert vision.extract_vision_text(_Page(), timeout_seconds=5.0, opener=http_error) is None


def test_vision_element_type_stays_a_text_element() -> None:
    elements = vision._line_elements(["가", "나"], page_width=720.0, page_height=360.0)
    assert all(isinstance(element, TextElement) for element in elements)

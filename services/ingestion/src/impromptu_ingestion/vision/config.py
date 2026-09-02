"""Vision endpoint configuration resolved from the process environment."""

import os
from collections.abc import Mapping
from dataclasses import dataclass

_DEFAULT_MODEL = "deepseek-v4-flash-vision-exp"
_PLACEHOLDER_SECRETS = {"", "local-chat-model-key-required"}


@dataclass(frozen=True)
class VisionConfig:
    base_url: str
    api_key: str
    model: str


def vision_config(environ: Mapping[str, str] = os.environ) -> VisionConfig | None:
    """Resolve the vision endpoint; ``None`` disables the pass entirely."""
    base_url = environ.get("IMPROMPTU_VISION_MODEL_BASE_URL") or environ.get("CHAT_MODEL_BASE_URL")
    api_key = (
        environ.get("IMPROMPTU_VISION_MODEL_API_KEY")
        or environ.get("OPENCODE_ZEN_API_KEY")
        or environ.get("CHAT_MODEL_API_KEY")
    )
    if not base_url or not api_key or api_key in _PLACEHOLDER_SECRETS:
        return None
    return VisionConfig(
        base_url=base_url.rstrip("/"),
        api_key=api_key,
        model=environ.get("IMPROMPTU_VISION_MODEL_NAME") or _DEFAULT_MODEL,
    )

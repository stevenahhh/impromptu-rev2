"""Shared contracts for structural extraction adapters."""

from abc import ABC, abstractmethod
from typing import NoReturn

from impromptu_ingestion.contracts import DeckManifest, InputKind, ValidatedInput


class StructuralExtractionError(RuntimeError):
    """A machine-identifiable parser failure safe to return from the worker."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


class RenderingUnsupportedError(RuntimeError):
    """Raised when callers cross the intentionally absent rendering boundary."""


class StructuralAdapter(ABC):
    """Extract structure without claiming visual render fidelity."""

    kind: InputKind

    def _require_kind(self, source: ValidatedInput) -> None:
        if source.kind is not self.kind:
            raise StructuralExtractionError(
                "adapter_kind_mismatch",
                f"{self.__class__.__name__} cannot extract {source.kind.value}",
            )

    @abstractmethod
    def extract(self, source: ValidatedInput) -> DeckManifest:
        """Extract a deterministic structural manifest."""

    @staticmethod
    def render_slides() -> NoReturn:
        raise RenderingUnsupportedError(
            "slide rendering is not configured; structural extraction cannot verify fidelity"
        )

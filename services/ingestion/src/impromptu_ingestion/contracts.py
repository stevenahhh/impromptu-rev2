"""Typed ingestion jobs and deterministic manifest contracts."""

from enum import StrEnum
from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
DeckId = Annotated[str, Field(pattern=r"^deck_[0-9a-f]{64}$")]
SlideKey = Annotated[str, Field(pattern=r"^slide_[0-9a-f]{64}$")]
JobId = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$")]


class ContractModel(BaseModel):
    """Closed, immutable base for machine-consumed contracts."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class InputKind(StrEnum):
    PPTX = "pptx"
    PDF = "pdf"


class IngestionJob(ContractModel):
    job_id: JobId
    source: Path
    expected_kind: InputKind | None = None
    max_input_bytes: Annotated[int, Field(gt=0, le=1_073_741_824)] = 104_857_600

    @model_validator(mode="after")
    def source_must_be_absolute(self) -> Self:
        if not self.source.is_absolute():
            raise ValueError("source must be an absolute local path")
        return self


class ValidatedInput(ContractModel):
    path: Path
    kind: InputKind
    size_bytes: Annotated[int, Field(gt=0)]
    source_sha256: Sha256


class RenderBoundary(ContractModel):
    status: Literal["not_performed"] = "not_performed"
    renderer: None = None
    fidelity_verified: Literal[False] = False
    reason: str

    @classmethod
    def structural_only(cls) -> Self:
        return cls(
            reason=(
                "Structural extraction only; slide rendering and visual fidelity verification "
                "require a separately configured renderer."
            )
        )


class ExtractionWarning(ContractModel):
    code: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{2,63}$")]
    message: str


class PositionedElement(ContractModel):
    element_id: Annotated[str, Field(min_length=1, max_length=128)]
    x: Annotated[float, Field(ge=0)]
    y: Annotated[float, Field(ge=0)]
    width: Annotated[float, Field(ge=0)]
    height: Annotated[float, Field(ge=0)]


class TextElement(PositionedElement):
    kind: Literal["text"] = "text"
    text: Annotated[str, Field(min_length=1)]


class TableElement(PositionedElement):
    kind: Literal["table"] = "table"
    rows: tuple[tuple[str, ...], ...]


class ImageElement(PositionedElement):
    kind: Literal["image"] = "image"
    content_sha256: Sha256
    media_type: Annotated[str, Field(pattern=r"^image/[a-z0-9.+-]+$")]
    pixel_width: Annotated[int, Field(gt=0)] | None = None
    pixel_height: Annotated[int, Field(gt=0)] | None = None


class ChartSeries(ContractModel):
    name: str
    values: tuple[str, ...]


class ChartElement(PositionedElement):
    kind: Literal["chart"] = "chart"
    chart_type: str
    categories: tuple[str, ...] = ()
    series: tuple[ChartSeries, ...] = ()


StructuralElement = Annotated[
    TextElement | TableElement | ImageElement | ChartElement,
    Field(discriminator="kind"),
]


class SlideManifest(ContractModel):
    slide_key: SlideKey
    source_index: Annotated[int, Field(gt=0)]
    source_id: Annotated[str, Field(min_length=1, max_length=128)]
    width_points: Annotated[float, Field(gt=0)]
    height_points: Annotated[float, Field(gt=0)]
    elements: tuple[StructuralElement, ...] = ()
    warnings: tuple[ExtractionWarning, ...] = ()


class DeckManifest(ContractModel):
    schema_version: Literal["1"] = "1"
    deck_id: DeckId
    source_sha256: Sha256
    source_kind: InputKind
    adapter_version: Annotated[str, Field(min_length=1, max_length=64)]
    slides: Annotated[tuple[SlideManifest, ...], Field(min_length=1)]
    render_boundary: RenderBoundary

    @model_validator(mode="after")
    def slides_are_unique_and_ordered(self) -> Self:
        indices = tuple(slide.source_index for slide in self.slides)
        if indices != tuple(range(1, len(self.slides) + 1)):
            raise ValueError("slides must have contiguous one-based source indices")
        keys = {slide.slide_key for slide in self.slides}
        if len(keys) != len(self.slides):
            raise ValueError("slide keys must be unique")
        return self


class CompletedIngestion(ContractModel):
    status: Literal["completed"] = "completed"
    job_id: JobId
    manifest_hash: Sha256
    manifest: DeckManifest


class PythonDoctorStatus(ContractModel):
    current: str
    required: Literal[">=3.14,<3.15"] = ">=3.14,<3.15"
    supported: bool


class RenderingDoctorStatus(ContractModel):
    status: Literal["not_configured"] = "not_configured"
    fidelity_verified: Literal[False] = False


class DoctorReport(ContractModel):
    ok: bool
    python: PythonDoctorStatus
    dependencies: dict[str, str]
    structural_extractors: dict[InputKind, bool]
    rendering: RenderingDoctorStatus
    ai_enabled: Literal[False] = False

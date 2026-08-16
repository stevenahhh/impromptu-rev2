"""Typed contracts for rendered slide artifacts and their animation timelines."""

from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, Field, model_validator

from impromptu_ingestion.contracts import ContractModel, DeckId, Sha256, SlideKey

_RELATIVE_PATH_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$"
_SVG_PATH_DATA_PATTERN = r"^[MmLlCcQqAaHhVvZzEe0-9 ,.\-]{1,4096}$"
_HEX_COLOR_PATTERN = r"^#[0-9A-Fa-f]{6}$"
_ELEMENT_ID_PATTERN = r"^[A-Za-z][A-Za-z0-9_.:-]{0,127}$"


def _contained_relative_path(value: str) -> str:
    """Reject anything that could escape the render output directory."""
    segments = value.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        raise ValueError("artifact paths must be relative and contain no traversal segments")
    return value


RelativeArtifactPath = Annotated[
    str, Field(pattern=_RELATIVE_PATH_PATTERN), AfterValidator(_contained_relative_path)
]
SvgElementId = Annotated[str, Field(pattern=_ELEMENT_ID_PATTERN)]


class EffectTrigger(StrEnum):
    """When one effect starts relative to its click group."""

    ON_CLICK = "on_click"
    WITH_PREVIOUS = "with_previous"
    AFTER_PREVIOUS = "after_previous"


class EffectClass(StrEnum):
    """The PowerPoint effect family an animation belongs to."""

    ENTRANCE = "entrance"
    EMPHASIS = "emphasis"
    EXIT = "exit"
    MOTION = "motion"


class RendererInfo(ContractModel):
    """The exact converter that produced the artifacts."""

    name: Literal["libreoffice", "pymupdf"] = "libreoffice"
    version: Annotated[str, Field(min_length=1, max_length=64)]


class RenderAsset(ContractModel):
    """One externalized binary the SVG references by relative path."""

    relative_path: RelativeArtifactPath
    media_type: Annotated[str, Field(pattern=r"^[a-z]+/[a-z0-9.+-]+$")]
    content_sha256: Sha256
    byte_size: Annotated[int, Field(gt=0)]


class EmbeddedFont(ContractModel):
    """One font the deck depends on, with the file that satisfies it when embedded."""

    family: Annotated[str, Field(min_length=1, max_length=128)]
    relative_path: RelativeArtifactPath | None = None
    embedded: bool = False

    @model_validator(mode="after")
    def embedded_fonts_need_a_file(self) -> Self:
        if self.embedded and self.relative_path is None:
            raise ValueError("an embedded font must reference its extracted file")
        return self


class RenderedSlide(ContractModel):
    """One converted slide surface."""

    slide_key: SlideKey
    source_index: Annotated[int, Field(gt=0)]
    relative_path: RelativeArtifactPath
    content_sha256: Sha256
    width_points: Annotated[float, Field(gt=0)]
    height_points: Annotated[float, Field(gt=0)]


class ResolvedTarget(ContractModel):
    """An OOXML shape resolved onto the element the renderer emitted for it."""

    shape_id: Annotated[int, Field(gt=0)]
    shape_name: Annotated[str, Field(min_length=1, max_length=128)]
    svg_element_id: SvgElementId


class FadeBehavior(ContractModel):
    kind: Literal["fade"] = "fade"
    direction: Literal["in", "out"]


class WipeBehavior(ContractModel):
    kind: Literal["wipe"] = "wipe"
    direction: Literal["in", "out"]
    edge: Literal["left", "right", "up", "down"]


class MotionBehavior(ContractModel):
    kind: Literal["motion"] = "motion"
    path: Annotated[str, Field(pattern=_SVG_PATH_DATA_PATTERN)]


class ColorBehavior(ContractModel):
    kind: Literal["color"] = "color"
    from_color: Annotated[str, Field(pattern=_HEX_COLOR_PATTERN)]
    to_color: Annotated[str, Field(pattern=_HEX_COLOR_PATTERN)]


AnimationBehavior = Annotated[
    FadeBehavior | WipeBehavior | MotionBehavior | ColorBehavior,
    Field(discriminator="kind"),
]


class SlideEffect(ContractModel):
    """One animation step whose target and behavior are both fully resolved."""

    trigger: EffectTrigger
    effect_class: EffectClass
    preset_id: Annotated[int, Field(ge=0)]
    preset_subtype: Annotated[int, Field(ge=0)] | None = None
    duration_ms: Annotated[int, Field(ge=0, le=600_000)]
    delay_ms: Annotated[int, Field(ge=0, le=600_000)]
    target: ResolvedTarget
    behavior: AnimationBehavior


class UnsupportedEffect(ContractModel):
    """An effect the renderer refuses to approximate."""

    reason_code: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{2,63}$")]
    preset_id: Annotated[int, Field(ge=0)] | None = None
    detail: Annotated[str, Field(min_length=1, max_length=512)]


class SlideTransition(ContractModel):
    """The slide-level transition PowerPoint declared."""

    kind: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{1,31}$")]
    advance_on_click: bool = True


class SlideTimeline(ContractModel):
    """Click-ordered animation groups for one slide."""

    slide_key: SlideKey
    click_groups: tuple[tuple[SlideEffect, ...], ...] = ()
    transition: SlideTransition | None = None
    unsupported: tuple[UnsupportedEffect, ...] = ()


class MappingIssue(ContractModel):
    """A structural disagreement between the source deck and the rendered output."""

    code: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{2,63}$")]
    slide_index: Annotated[int, Field(gt=0)]
    path: Annotated[str, Field(min_length=1, max_length=128)]
    detail: Annotated[str, Field(min_length=1, max_length=512)]


class RenderedDeck(ContractModel):
    """Every artifact one render produced, with its animation eligibility decided."""

    deck_id: DeckId
    renderer: RendererInfo
    slides: tuple[RenderedSlide, ...] = Field(min_length=1)
    assets: tuple[RenderAsset, ...] = ()
    fonts: tuple[EmbeddedFont, ...] = ()
    timelines: tuple[SlideTimeline, ...] = ()
    mapping_issues: tuple[MappingIssue, ...] = ()
    animation_eligible: bool
    ineligible_reason: Annotated[str, Field(min_length=1, max_length=512)] | None = None

    @model_validator(mode="after")
    def eligibility_must_follow_the_evidence(self) -> Self:
        blocked = bool(self.mapping_issues) or any(
            timeline.unsupported for timeline in self.timelines
        )
        if self.animation_eligible and blocked:
            raise ValueError(
                "animation_eligible cannot be true while mapping issues or unsupported "
                "effects are recorded"
            )
        if not self.animation_eligible and self.ineligible_reason is None:
            raise ValueError("an animation-ineligible deck must carry a machine-readable reason")
        if self.animation_eligible and self.ineligible_reason is not None:
            raise ValueError("an animation-eligible deck must not carry an ineligible reason")
        return self

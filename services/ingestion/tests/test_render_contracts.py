import pytest
from pydantic import ValidationError

from impromptu_ingestion.render.contracts import (
    ColorBehavior,
    EffectClass,
    EffectTrigger,
    FadeBehavior,
    MappingIssue,
    MotionBehavior,
    RenderAsset,
    RenderedDeck,
    RenderedSlide,
    RendererInfo,
    ResolvedTarget,
    SlideEffect,
    SlideTimeline,
    UnsupportedEffect,
)

_SHA = "a" * 64
_SLIDE_KEY = "slide_" + "b" * 64
_DECK_ID = "deck_" + "c" * 64


def _asset() -> RenderAsset:
    return RenderAsset(
        relative_path="assets/asset_" + _SHA + ".png",
        media_type="image/png",
        content_sha256=_SHA,
        byte_size=17,
    )


def _slide(index: int = 1) -> RenderedSlide:
    return RenderedSlide(
        slide_key=_SLIDE_KEY,
        source_index=index,
        relative_path=f"slides/slide-{index}.svg",
        content_sha256=_SHA,
        width_points=960.0,
        height_points=540.0,
    )


def _effect(svg_element_id: str = "id3") -> SlideEffect:
    return SlideEffect(
        trigger=EffectTrigger.ON_CLICK,
        effect_class=EffectClass.ENTRANCE,
        preset_id=1,
        preset_subtype=0,
        duration_ms=500,
        delay_ms=0,
        target=ResolvedTarget(shape_id=2, shape_name="ShapeA", svg_element_id=svg_element_id),
        behavior=FadeBehavior(direction="in"),
    )


def _timeline(effects: tuple[SlideEffect, ...] = ()) -> SlideTimeline:
    return SlideTimeline(
        slide_key=_SLIDE_KEY,
        click_groups=((effects,) if effects else ()),
    )


def _deck(
    timelines: tuple[SlideTimeline, ...],
    *,
    animation_eligible: bool,
    mapping_issues: tuple[MappingIssue, ...] = (),
    ineligible_reason: str | None = None,
) -> RenderedDeck:
    return RenderedDeck(
        deck_id=_DECK_ID,
        renderer=RendererInfo(name="libreoffice", version="25.2.5.2"),
        slides=(_slide(),),
        assets=(_asset(),),
        fonts=(),
        timelines=timelines,
        mapping_issues=mapping_issues,
        animation_eligible=animation_eligible,
        ineligible_reason=ineligible_reason,
    )


def test_rendered_artifacts_are_frozen_and_closed() -> None:
    slide = _slide()
    with pytest.raises(ValidationError):
        slide.source_index = 2  # type: ignore[misc]
    with pytest.raises(ValidationError):
        RenderedSlide(
            slide_key=_SLIDE_KEY,
            source_index=1,
            relative_path="slides/slide-1.svg",
            content_sha256=_SHA,
            width_points=960.0,
            height_points=540.0,
            unexpected="leak",  # type: ignore[call-arg]
        )


@pytest.mark.parametrize(
    "escaping_path",
    ["/etc/passwd", "C:/Windows/win.ini", "../outside.svg", "slides/../../outside.svg"],
)
def test_artifact_paths_must_stay_inside_the_render_directory(escaping_path: str) -> None:
    with pytest.raises(ValidationError):
        RenderedSlide(
            slide_key=_SLIDE_KEY,
            source_index=1,
            relative_path=escaping_path,
            content_sha256=_SHA,
            width_points=960.0,
            height_points=540.0,
        )


def test_deck_with_only_supported_effects_may_be_animation_eligible() -> None:
    deck = _deck((_timeline((_effect(),)),), animation_eligible=True)

    assert deck.animation_eligible is True
    assert deck.ineligible_reason is None
    assert deck.timelines[0].click_groups[0][0].target.svg_element_id == "id3"


def test_unsupported_effect_forces_animation_ineligibility() -> None:
    timeline = SlideTimeline(
        slide_key=_SLIDE_KEY,
        click_groups=(),
        unsupported=(
            UnsupportedEffect(
                reason_code="unknown_preset",
                preset_id=1234,
                detail="preset 1234 has no verified web mapping",
            ),
        ),
    )

    with pytest.raises(ValidationError):
        _deck((timeline,), animation_eligible=True)

    deck = _deck(
        (timeline,),
        animation_eligible=False,
        ineligible_reason="unsupported effects present",
    )
    assert deck.animation_eligible is False


def test_mapping_issue_forces_animation_ineligibility() -> None:
    issue = MappingIssue(
        code="child_count_mismatch",
        slide_index=1,
        path="slide1.0",
        detail="ooxml 3 vs svg 2",
    )

    with pytest.raises(ValidationError):
        _deck((_timeline((_effect(),)),), animation_eligible=True, mapping_issues=(issue,))


def test_ineligible_deck_must_carry_a_machine_readable_reason() -> None:
    with pytest.raises(ValidationError):
        _deck((_timeline((_effect(),)),), animation_eligible=False)


def test_effect_target_requires_a_resolved_svg_element() -> None:
    with pytest.raises(ValidationError):
        ResolvedTarget(shape_id=2, shape_name="ShapeA", svg_element_id="")


def test_behaviors_are_a_closed_discriminated_union() -> None:
    motion = MotionBehavior(path="M 0 1 L 0 0 E")
    color = ColorBehavior(from_color="#0070C0", to_color="#FF0000")

    assert motion.kind == "motion"
    assert color.kind == "color"
    with pytest.raises(ValidationError):
        MotionBehavior(path="M 0 0 </svg><script>alert(1)</script>")
    with pytest.raises(ValidationError):
        ColorBehavior(from_color="red", to_color="#FF0000")

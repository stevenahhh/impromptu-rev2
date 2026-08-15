import re
from collections.abc import Mapping
from typing import Literal, assert_never, cast
from xml.etree import ElementTree

from impromptu_ingestion.render import contracts as c

_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_MAX_EFFECTS = 2_000
_SAFE_PATH = re.compile(r"[^MmLlCcQqAaHhVvZzEe0-9 ,.\-]")
_HEX_COLOR = re.compile(r"#[0-9A-Fa-f]{6}")
type _BehaviorTag = Literal[
    "animEffect", "animMotion", "anim", "set", "animScale", "animRot", "animClr"
]
_BEHAVIOR_TAGS: dict[str, _BehaviorTag] = {
    name: name
    for name in ("animEffect", "animMotion", "anim", "set", "animScale", "animRot", "animClr")
}
type _Behavior = c.FadeBehavior | c.WipeBehavior | c.MotionBehavior | c.ColorBehavior


class TimingParseError(ValueError):
    def __init__(self, code: str, detail: str) -> None:
        self.code = code
        super().__init__(detail)


def _q(local: str) -> str:
    return f"{{{_P}}}{local}"


def _local(element: ElementTree.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _unsupported(reason: str, preset_id: int | None, detail: str) -> c.UnsupportedEffect:
    return c.UnsupportedEffect(reason_code=reason, preset_id=preset_id, detail=detail)


def _optional_int(raw: str | None) -> int | None:
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _effect_class(raw: str | None) -> c.EffectClass | None:
    match raw:
        case "entr":
            return c.EffectClass.ENTRANCE
        case "exit":
            return c.EffectClass.EXIT
        case "emph":
            return c.EffectClass.EMPHASIS
        case "path":
            return c.EffectClass.MOTION
        case _:
            return None


def _trigger(raw: str | None) -> c.EffectTrigger | None:
    match raw:
        case "clickEffect":
            return c.EffectTrigger.ON_CLICK
        case "withEffect":
            return c.EffectTrigger.WITH_PREVIOUS
        case "afterEffect":
            return c.EffectTrigger.AFTER_PREVIOUS
        case _:
            return None


def _duration(behavior: ElementTree.Element) -> tuple[int | None, str | None]:
    cbhvr = behavior.find(_q("cBhvr"))
    candidates = () if cbhvr is None else tuple(cbhvr.findall(_q("cTn")))
    raw = next((node.get("dur") for node in candidates if node.get("dur") is not None), None)
    if raw is None or raw == "indefinite":
        return None, "indefinite_duration"
    value = _optional_int(raw)
    if value is None:
        return None, "invalid_duration"
    if not 0 <= value <= 600_000:
        return None, "duration_out_of_range"
    return value, None


def _parse_behavior(
    behavior: ElementTree.Element, tag: _BehaviorTag, preset_id: int | None
) -> _Behavior | c.UnsupportedEffect:
    match tag:
        case "animEffect":
            raw_direction = behavior.get("transition")
            if raw_direction not in {"in", "out"}:
                return _unsupported(
                    "unknown_direction", preset_id, "animEffect direction is not in/out"
                )
            direction = cast(Literal["in", "out"], raw_direction)
            effect_filter = behavior.get("filter", "")
            if effect_filter.startswith("fade"):
                return c.FadeBehavior(direction=direction)
            if effect_filter.startswith("wipe"):
                edge_match = re.fullmatch(r"wipe\((left|right|up|down)\)", effect_filter)
                if edge_match is None:
                    return _unsupported("malformed_wipe_filter", preset_id, effect_filter)
                edge = cast(Literal["left", "right", "up", "down"], edge_match.group(1))
                return c.WipeBehavior(direction=direction, edge=edge)
            return _unsupported("unknown_filter", preset_id, effect_filter or "missing filter")
        case "animMotion":
            raw_path = behavior.get("path", "")
            path = _SAFE_PATH.sub("", raw_path)
            if not path or len(path) > 4_096:
                return _unsupported("malformed_motion_path", preset_id, "motion path is invalid")
            return c.MotionBehavior(path=path)
        case "anim":
            start, end = behavior.get("from"), behavior.get("to")
            if (
                behavior.get("clrSpc") != "rgb"
                or start is None
                or end is None
                or _HEX_COLOR.fullmatch(start) is None
                or _HEX_COLOR.fullmatch(end) is None
            ):
                return _unsupported("malformed_color", preset_id, "rgb hex endpoints are required")
            return c.ColorBehavior(from_color=start, to_color=end)
        case "set" | "animScale" | "animRot" | "animClr":
            return _unsupported("unsupported_behavior", preset_id, f"{tag} has no exact mapping")
    assert_never(tag)


def _parse_effect(
    node: ElementTree.Element, targets: Mapping[int, c.ResolvedTarget]
) -> c.SlideEffect | c.UnsupportedEffect:
    preset_id = _optional_int(node.get("presetID"))
    if node.get("presetID") is not None and (preset_id is None or preset_id < 0):
        return _unsupported("invalid_preset_id", None, "presetID is not a non-negative integer")
    effect_class = _effect_class(node.get("presetClass"))
    if effect_class is None:
        return _unsupported("unknown_preset_class", preset_id, "presetClass is not supported")
    trigger = _trigger(node.get("nodeType"))
    if trigger is None:
        return _unsupported("unknown_trigger", preset_id, "nodeType is not a supported trigger")
    behaviors = tuple(
        descendant for descendant in node.iter() if _local(descendant) in _BEHAVIOR_TAGS
    )
    if len(behaviors) != 1:
        return _unsupported("ambiguous_behavior", preset_id, f"found {len(behaviors)} behaviors")
    behavior_node = behaviors[0]
    tag = _BEHAVIOR_TAGS[_local(behavior_node)]
    parsed_behavior = _parse_behavior(behavior_node, tag, preset_id)
    if isinstance(parsed_behavior, c.UnsupportedEffect):
        return parsed_behavior
    duration, duration_error = _duration(behavior_node)
    if duration_error is not None or duration is None:
        return _unsupported(duration_error or "indefinite_duration", preset_id, "invalid duration")
    target_element = behavior_node.find(f"{_q('cBhvr')}/{_q('tgtEl')}")
    if target_element is None:
        return _unsupported("missing_target", preset_id, "behavior has no target")
    if any(_local(item) in {"txtEl", "txtTgtEl"} for item in target_element.iter()):
        return _unsupported("text_range_target", preset_id, "text ranges are not supported")
    shape_target = target_element.find(f".//{_q('spTgt')}")
    shape_id = None if shape_target is None else _optional_int(shape_target.get("spid"))
    if shape_id is None or shape_id not in targets:
        detail = (
            "missing or invalid spid" if shape_id is None else f"shape {shape_id} is unresolved"
        )
        return _unsupported("unresolved_target", preset_id, detail)
    delay_node = node.find(f"{_q('stCondLst')}/{_q('cond')}")
    delay_raw = None if delay_node is None else delay_node.get("delay")
    delay = 0 if delay_raw in {None, "indefinite"} else _optional_int(delay_raw)
    if delay is None:
        return _unsupported("invalid_delay", preset_id, "delay is not an integer")
    if not 0 <= delay <= 600_000:
        return _unsupported("delay_out_of_range", preset_id, "delay exceeds contract bounds")
    subtype_raw = node.get("presetSubtype")
    subtype = _optional_int(subtype_raw)
    if subtype_raw is not None and (subtype is None or subtype < 0):
        return _unsupported("invalid_preset_subtype", preset_id, "presetSubtype is invalid")
    return c.SlideEffect(
        trigger=trigger,
        effect_class=effect_class,
        preset_id=preset_id or 0,
        preset_subtype=subtype,
        duration_ms=duration,
        delay_ms=delay,
        target=targets[shape_id],
        behavior=parsed_behavior,
    )


def _transition(root: ElementTree.Element) -> c.SlideTransition | None:
    node = root.find(_q("transition"))
    if node is None or len(node) == 0:
        return None
    raw_kind = _local(node[0])
    kind = re.sub(r"(?<!^)(?=[A-Z])", "_", raw_kind).lower()
    advance = node.get("advClick", "1").lower() not in {"0", "false", "off", "no"}
    return c.SlideTransition(kind=kind, advance_on_click=advance)


def parse_slide_timeline(
    slide_xml: bytes,
    slide_key: str,
    targets: Mapping[int, c.ResolvedTarget],
) -> c.SlideTimeline:
    """Parse one slide's timing tree, preserving click-group and effect order."""
    try:
        root = ElementTree.fromstring(slide_xml)
    except ElementTree.ParseError as error:
        raise TimingParseError("malformed_xml", str(error)) from error
    main_sequences = tuple(
        sequence
        for sequence in root.findall(f".//{_q('seq')}")
        if (control := sequence.find(_q("cTn"))) is not None
        and control.get("nodeType") == "mainSeq"
    )
    groups = tuple(
        group
        for sequence in main_sequences
        for group in sequence.findall(f"{_q('cTn')}/{_q('childTnLst')}/{_q('par')}")
    )
    effect_groups = tuple(
        tuple(node for node in group.iter(_q("cTn")) if node.get("presetID") is not None)
        for group in groups
    )
    if sum(map(len, effect_groups)) > _MAX_EFFECTS:
        raise TimingParseError("effect_limit_exceeded", f"slide exceeds {_MAX_EFFECTS} effects")
    parsed_groups: list[tuple[c.SlideEffect, ...]] = []
    unsupported: list[c.UnsupportedEffect] = []
    for effect_group in effect_groups:
        supported: list[c.SlideEffect] = []
        for effect_node in effect_group:
            parsed = _parse_effect(effect_node, targets)
            match parsed:
                case c.SlideEffect() as effect:
                    supported.append(effect)
                    continue
                case c.UnsupportedEffect() as rejected:
                    unsupported.append(rejected)
                    continue
            assert_never(parsed)
        parsed_groups.append(tuple(supported))
    return c.SlideTimeline(
        slide_key=slide_key,
        click_groups=tuple(parsed_groups),
        transition=_transition(root),
        unsupported=tuple(unsupported),
    )

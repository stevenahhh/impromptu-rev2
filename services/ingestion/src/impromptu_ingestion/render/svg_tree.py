from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, assert_never
from xml.etree import ElementTree as ET

MAX_NODES, MAX_DEPTH = 50_000, 64
SIMPLE_CLASSES = frozenset({"Group", "Graphic", "TitleText", "Outline", "Subtitle", "Body"})
SHAPE_TAGS = frozenset({"sp", "grpSp", "pic", "cxnSp", "graphicFrame"})


class MappingParseError(ValueError):
    code: Literal["invalid_slide_xml", "invalid_slide_svg", "xml_limit_exceeded"]

    def __init__(
        self,
        code: Literal["invalid_slide_xml", "invalid_slide_svg", "xml_limit_exceeded"],
        detail: str,
    ) -> None:
        self.code = code
        super().__init__(detail)


class ShapeKind(StrEnum):
    AUTO_SHAPE = "CustomShape"
    GROUP = "Group"
    PICTURE = "Graphic"
    LINE = "ConnectorShape"
    TABLE = "TableShape"


@dataclass(frozen=True)
class OoxmlShape:
    shape_id: int
    name: str
    kind: ShapeKind
    expected_class: str
    center: tuple[float, float] | None
    children: tuple[OoxmlShape, ...] = ()


@dataclass(frozen=True)
class SvgShape:
    element: ET.Element
    class_name: str
    center: tuple[float, float]
    children: tuple[SvgShape, ...] = ()


Transform = tuple[float, float, float, float]


def local(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def child(element: ET.Element, name: str) -> ET.Element | None:
    return next((item for item in element if local(item) == name), None)


def descendant(element: ET.Element, name: str) -> ET.Element | None:
    return next((item for item in element.iter() if local(item) == name), None)


def parse_xml(
    source: bytes | str, code: Literal["invalid_slide_xml", "invalid_slide_svg"]
) -> ET.Element:
    if isinstance(source, bytes):
        forbidden = b"<!DOCTYPE" in source or b"<!ENTITY" in source
    else:
        forbidden = "<!DOCTYPE" in source or "<!ENTITY" in source
    if forbidden:
        raise MappingParseError(code, "DOCTYPE and ENTITY declarations are forbidden")
    try:
        root = ET.fromstring(source)
    except (ET.ParseError, ValueError, TypeError) as error:
        raise MappingParseError(code, str(error)) from error
    count = 0
    stack: list[tuple[ET.Element, int]] = [(root, 1)]
    while stack:
        element, depth = stack.pop()
        count += 1
        if count > MAX_NODES or depth > MAX_DEPTH:
            raise MappingParseError("xml_limit_exceeded", "XML exceeds mapping safety limits")
        stack.extend((item, depth + 1) for item in element)
    return root


def shape_kind(element: ET.Element) -> ShapeKind:
    match local(element):
        case "sp":
            return ShapeKind.AUTO_SHAPE
        case "grpSp":
            return ShapeKind.GROUP
        case "pic":
            return ShapeKind.PICTURE
        case "cxnSp":
            return ShapeKind.LINE
        case "graphicFrame":
            if descendant(element, "tbl") is not None:
                return ShapeKind.TABLE
            raise MappingParseError("invalid_slide_xml", "unsupported non-table graphicFrame")
        case unknown:
            raise MappingParseError("invalid_slide_xml", f"unsupported shape element {unknown}")


def _nested_xfrm(properties: ET.Element | None) -> ET.Element:
    transform = None if properties is None else descendant(properties, "xfrm")
    if transform is None:
        raise MappingParseError("invalid_slide_xml", "shape lacks a transform")
    return transform


def xfrm(element: ET.Element, kind: ShapeKind) -> ET.Element:
    match kind:
        case ShapeKind.GROUP:
            return _nested_xfrm(child(element, "grpSpPr"))
        case ShapeKind.AUTO_SHAPE | ShapeKind.PICTURE | ShapeKind.LINE:
            return _nested_xfrm(child(element, "spPr"))
        case ShapeKind.TABLE:
            return _nested_xfrm(element)
    assert_never(kind)


def _number(
    element: ET.Element,
    name: str,
    code: Literal["invalid_slide_xml", "invalid_slide_svg"] = "invalid_slide_xml",
) -> float:
    value = element.get(name)
    if value is None:
        raise MappingParseError(code, f"missing numeric attribute {name}")
    try:
        return float(value)
    except ValueError as error:
        raise MappingParseError(code, f"invalid numeric attribute {name}") from error


def coordinates(transform: ET.Element) -> tuple[float, float, float, float]:
    off, ext = child(transform, "off"), child(transform, "ext")
    if off is None or ext is None:
        raise MappingParseError("invalid_slide_xml", "shape transform lacks offset or extent")
    return _number(off, "x"), _number(off, "y"), _number(ext, "cx"), _number(ext, "cy")


def ooxml_shapes(
    parent: ET.Element,
    transform: Transform = (1.0, 1.0, 0.0, 0.0),
    placeholder_count: list[int] | None = None,
) -> tuple[OoxmlShape, ...]:
    count = [0] if placeholder_count is None else placeholder_count
    result: list[OoxmlShape] = []
    for element in parent:
        if local(element) not in SHAPE_TAGS:
            continue
        properties = descendant(element, "cNvPr")
        if properties is None:
            raise MappingParseError("invalid_slide_xml", "shape lacks non-visual properties")
        if properties.get("hidden") == "1":
            continue
        kind = shape_kind(element)
        placeholder = descendant(element, "ph") is not None
        shape_transform = descendant(element, "xfrm") if placeholder else xfrm(element, kind)
        if shape_transform is None:
            center = None
            x = y = width = height = 0.0
        else:
            x, y, width, height = coordinates(shape_transform)
            sx, sy, tx, ty = transform
            center = (tx + sx * (x + width / 2), ty + sy * (y + height / 2))
        expected = "TitleText" if placeholder and count[0] == 0 else "Outline"
        if placeholder:
            count[0] += 1
        else:
            expected = kind.value
        children: tuple[OoxmlShape, ...] = ()
        if kind is ShapeKind.GROUP:
            group_transform = xfrm(element, kind)
            child_off, child_ext = child(group_transform, "chOff"), child(group_transform, "chExt")
            if child_off is None or child_ext is None:
                raise MappingParseError("invalid_slide_xml", "group lacks child coordinates")
            try:
                cx, cy = _number(child_off, "x"), _number(child_off, "y")
                cw, ch = _number(child_ext, "cx"), _number(child_ext, "cy")
                sx, sy, tx, ty = transform
                nested = (
                    sx * width / cw,
                    sy * height / ch,
                    tx + sx * x - sx * width * cx / cw,
                    ty + sy * y - sy * height * cy / ch,
                )
            except (TypeError, ValueError, ZeroDivisionError) as error:
                raise MappingParseError("invalid_slide_xml", "invalid group transform") from error
            children = ooxml_shapes(element, nested, count)
        result.append(
            OoxmlShape(
                int(properties.get("id", "0")),
                properties.get("name", ""),
                kind,
                expected,
                center,
                children,
            )
        )
    return tuple(result)


def _svg_class(element: ET.Element) -> str | None:
    value = element.get("class", "")
    if value.startswith("com.sun.star."):
        return value.rsplit(".", 1)[-1]
    return value if value in SIMPLE_CLASSES else None


def _svg_center(element: ET.Element, class_name: str) -> tuple[float, float]:
    rects = [
        item
        for item in element.iter()
        if local(item) == "rect" and item.get("class") == "BoundingBox"
    ]
    if not rects:
        raise MappingParseError("invalid_slide_svg", f"{class_name} lacks BoundingBox")
    selected = rects if class_name in SIMPLE_CLASSES else rects[:1]
    try:
        boxes = [
            (
                _number(rect, "x", "invalid_slide_svg"),
                _number(rect, "y", "invalid_slide_svg"),
                _number(rect, "width", "invalid_slide_svg"),
                _number(rect, "height", "invalid_slide_svg"),
            )
            for rect in selected
        ]
    except (TypeError, ValueError) as error:
        raise MappingParseError("invalid_slide_svg", "invalid BoundingBox") from error
    left, top = min(box[0] for box in boxes), min(box[1] for box in boxes)
    right = max(box[0] + box[2] for box in boxes)
    bottom = max(box[1] + box[3] for box in boxes)
    return (left + right) / 2, (top + bottom) / 2


def svg_shapes(parent: ET.Element) -> tuple[SvgShape, ...]:
    result: list[SvgShape] = []
    for element in parent:
        class_name = _svg_class(element)
        if class_name is None:
            continue
        children = svg_shapes(element) if class_name == "Group" else ()
        result.append(SvgShape(element, class_name, _svg_center(element, class_name), children))
    return tuple(result)

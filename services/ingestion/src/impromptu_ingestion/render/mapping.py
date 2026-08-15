"""Prove the structural correspondence between a slide's OOXML and rendered SVG."""

from math import hypot
from re import fullmatch

from impromptu_ingestion.contracts import ContractModel
from impromptu_ingestion.render.contracts import MappingIssue, ResolvedTarget
from impromptu_ingestion.render.svg_tree import (
    MappingParseError,
    OoxmlShape,
    ShapeKind,
    SvgShape,
    descendant,
    local,
    ooxml_shapes,
    parse_xml,
    svg_shapes,
)

_CENTER_TOLERANCE = 150.0
_ID_PATTERN = r"[A-Za-z][A-Za-z0-9_.:-]{0,127}"


class SlideMapping(ContractModel):
    """Resolved animation targets and all structural disagreements for one slide."""

    slide_index: int
    targets: tuple[ResolvedTarget, ...]
    issues: tuple[MappingIssue, ...]


def _element_id(container: SvgShape) -> str | None:
    for candidate in container.element.iter():
        value = candidate.get("id") if local(candidate) == "g" else None
        if value is not None and fullmatch(_ID_PATTERN, value) is not None:
            return value
    return None


def map_slide(slide_xml: bytes, slide_svg: str, slide_index: int) -> SlideMapping:
    """Map OOXML shapes to SVG containers while recording every disagreement."""
    xml_root = parse_xml(slide_xml, "invalid_slide_xml")
    svg_root = parse_xml(slide_svg, "invalid_slide_svg")
    shape_tree = descendant(xml_root, "spTree")
    page = next(
        (item for item in svg_root.iter() if local(item) == "g" and item.get("class") == "Page"),
        None,
    )
    if shape_tree is None or page is None:
        code = "invalid_slide_xml" if shape_tree is None else "invalid_slide_svg"
        raise MappingParseError(code, "input lacks a shape tree or SVG Page container")
    source, rendered = ooxml_shapes(shape_tree), svg_shapes(page)
    targets: list[ResolvedTarget] = []
    issues: list[MappingIssue] = []

    def issue(code: str, path: str, detail: str) -> None:
        issues.append(MappingIssue(code=code, slide_index=slide_index, path=path, detail=detail))

    def compare(left: tuple[OoxmlShape, ...], right: tuple[SvgShape, ...], path: str) -> None:
        if len(left) != len(right):
            code = (
                "top_level_count_mismatch"
                if path == f"slide{slide_index}"
                else "child_count_mismatch"
            )
            issue(code, path, f"OOXML has {len(left)} containers; SVG has {len(right)}")
        for index, (shape, container) in enumerate(zip(left, right, strict=False)):
            item_path = f"{path}.{index}"
            if shape.expected_class != container.class_name:
                detail = (
                    f"OOXML {shape.name} expects {shape.expected_class}; "
                    f"SVG has {container.class_name}"
                )
                issue("type_mismatch", item_path, detail)
            source_center = (
                None if shape.center is None else (shape.center[0] / 360, shape.center[1] / 360)
            )
            if (
                source_center is not None
                and hypot(
                    source_center[0] - container.center[0],
                    source_center[1] - container.center[1],
                )
                > _CENTER_TOLERANCE
            ):
                detail = (
                    f"OOXML {shape.name} center {source_center}; "
                    f"SVG {container.class_name} center {container.center}"
                )
                issue("center_mismatch", item_path, detail)
            element_id = _element_id(container)
            if element_id is None:
                detail = f"OOXML {shape.name}; SVG {container.class_name} has no usable element id"
                issue("missing_element_id", item_path, detail)
            else:
                targets.append(
                    ResolvedTarget(
                        shape_id=shape.shape_id,
                        shape_name=shape.name,
                        svg_element_id=element_id,
                    )
                )
            if shape.kind is ShapeKind.GROUP:
                compare(shape.children, container.children, item_path)

    compare(source, rendered, f"slide{slide_index}")
    return SlideMapping(slide_index=slide_index, targets=tuple(targets), issues=tuple(issues))

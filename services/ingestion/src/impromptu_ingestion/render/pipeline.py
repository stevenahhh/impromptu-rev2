"""Render one deck into per-slide SVG, externalized assets, and animation timelines."""

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

from lxml import etree

from impromptu_ingestion.canonical import deck_id, slide_key
from impromptu_ingestion.render.assets import externalize_assets, extract_fonts, write_assets
from impromptu_ingestion.render.contracts import (
    MappingIssue,
    RenderAsset,
    RenderedDeck,
    RenderedSlide,
    RendererInfo,
    ResolvedTarget,
    SlideTimeline,
)
from impromptu_ingestion.render.libreoffice import SvgConverter, split_slides
from impromptu_ingestion.render.mapping import map_slide
from impromptu_ingestion.render.timing import parse_slide_timeline

_SLIDE_PART = re.compile(r"^ppt/slides/slide(\d+)\.xml$")
_MAX_SLIDE_XML_BYTES = 8_000_000
_DEFAULT_SLIDE_POINTS = (960.0, 540.0)
_EMU_PER_POINT = 12_700
_IGNORED_SVG_CLASSES = frozenset(
    {"Background", "BackgroundObjects", "DateTime", "Footer", "PageNumber", "Header"}
)


class RenderError(RuntimeError):
    """A machine-identifiable render failure safe to return from the worker."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


@dataclass(frozen=True, slots=True)
class RenderRequest:
    """One deck render, with its converter injected so the binary stays replaceable."""

    source: Path
    output_dir: Path
    converter: SvgConverter
    renderer_version: str = "unknown"


def _require_empty_output(output_dir: Path) -> None:
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RenderError("output_directory_not_empty", f"{output_dir} already has contents")
    output_dir.mkdir(parents=True, exist_ok=True)


def _slide_parts(source: Path) -> tuple[tuple[str, bytes], ...]:
    try:
        with ZipFile(source) as archive:
            numbered = [
                (int(match[1]), match[0])
                for name in archive.namelist()
                if (match := _SLIDE_PART.match(name)) is not None
            ]
            names = [name for _, name in sorted(numbered)]
            parts: list[tuple[str, bytes]] = []
            for name in names:
                info = archive.getinfo(name)
                if info.file_size > _MAX_SLIDE_XML_BYTES:
                    raise RenderError("slide_xml_too_large", f"{name} exceeds the slide XML limit")
                parts.append((name, archive.read(name)))
            return tuple(parts)
    except BadZipFile as error:
        raise RenderError("source_not_a_pptx", "source is not a readable PPTX package") from error


def _slide_size_points(source: Path) -> tuple[float, float]:
    with ZipFile(source) as archive:
        try:
            presentation = archive.read("ppt/presentation.xml").decode("utf-8", "replace")
        except KeyError:
            return _DEFAULT_SLIDE_POINTS
    match = re.search(r'sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"', presentation)
    if match is None:
        return _DEFAULT_SLIDE_POINTS
    return (int(match[1]) / _EMU_PER_POINT, int(match[2]) / _EMU_PER_POINT)


def _stamp_container_ids(svg_text: str, slide_index: int) -> str:
    """Give every drawing container a stable id, because LibreOffice omits some entirely.

    lxml is used deliberately: the stdlib serializer rewrites LibreOffice's declared
    namespace prefixes to ns0-style names, which would corrupt the published SVG.
    """
    root = etree.fromstring(
        svg_text.encode("utf-8"),
        parser=etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False),
    )
    page = None
    for element in root.iter():
        if etree.QName(element).localname == "g" and element.get("class") == "Page":
            page = element
            break
    if page is None:
        raise RenderError("svg_without_page", f"slide {slide_index} SVG has no Page container")

    ordinal = 0
    pending = [page]
    while pending:
        parent = pending.pop(0)
        for element in parent:
            if not isinstance(element.tag, str) or etree.QName(element).localname != "g":
                continue
            class_name = element.get("class")
            if class_name is None or class_name in _IGNORED_SVG_CLASSES:
                continue
            ordinal += 1
            has_id = any(
                candidate.get("id") is not None
                for candidate in element.iter()
                if isinstance(candidate.tag, str) and etree.QName(candidate).localname == "g"
            )
            if not has_id:
                element.set("id", f"impromptu-s{slide_index}-{ordinal}")
            if class_name == "Group":
                pending.append(element)
    return etree.tostring(root, encoding="unicode")


def _strip_prologue(svg_text: str) -> str:
    """Drop the XML declaration and DOCTYPE so no DTD ever reaches the strict parsers.

    LibreOffice always emits an SVG 1.1 DOCTYPE. Removing the whole prologue keeps any
    internal entity subset out of the document instead of trusting a parser flag.
    """
    start = svg_text.find("<svg")
    if start < 0:
        raise RenderError("converter_produced_no_svg", "converter output has no svg element")
    return svg_text[start:]


def _convert(request: RenderRequest) -> str:
    with TemporaryDirectory(prefix="impromptu-render-") as scratch:
        produced = request.converter.convert(request.source, Path(scratch))
        if not produced.is_file():
            raise RenderError("converter_produced_no_svg", "converter returned a missing path")
        return _strip_prologue(produced.read_text(encoding="utf-8"))


def render_deck(request: RenderRequest) -> RenderedDeck:
    """Convert, verify, and publish one deck's render artifacts under the output directory."""
    if not request.source.is_file():
        raise RenderError("source_missing", f"{request.source} is not a file")
    _require_empty_output(request.output_dir)

    source_sha256 = hashlib.sha256(request.source.read_bytes()).hexdigest()
    slide_parts = _slide_parts(request.source)
    slide_svgs = split_slides(_convert(request))
    if len(slide_svgs) != len(slide_parts):
        raise RenderError(
            "slide_count_mismatch",
            f"deck declares {len(slide_parts)} slides but the renderer produced {len(slide_svgs)}",
        )

    width_points, height_points = _slide_size_points(request.source)
    slides: list[RenderedSlide] = []
    assets: list[RenderAsset] = []
    timelines: list[SlideTimeline] = []
    issues: list[MappingIssue] = []

    for index, ((part_name, slide_xml), converted) in enumerate(
        zip(slide_parts, slide_svgs, strict=True), 1
    ):
        raw_svg = _stamp_container_ids(converted, index)
        mapping = map_slide(slide_xml, raw_svg, index)
        issues.extend(mapping.issues)
        targets: dict[int, ResolvedTarget] = {target.shape_id: target for target in mapping.targets}
        key = slide_key(source_sha256, part_name)
        timelines.append(parse_slide_timeline(slide_xml, key, targets))

        svg_text, slide_assets, payloads = externalize_assets(raw_svg)
        write_assets(slide_assets, payloads, request.output_dir)
        assets.extend(slide_assets)

        relative = f"slides/slide-{index}.svg"
        destination = request.output_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(svg_text, encoding="utf-8")
        slides.append(
            RenderedSlide(
                slide_key=key,
                source_index=index,
                relative_path=relative,
                content_sha256=hashlib.sha256(svg_text.encode("utf-8")).hexdigest(),
                width_points=width_points,
                height_points=height_points,
            )
        )

    unsupported = sum(len(timeline.unsupported) for timeline in timelines)
    eligible = not issues and unsupported == 0
    reason: str | None = None
    if not eligible:
        reason = (
            f"{len(issues)} structural mapping issue(s) and {unsupported} unsupported effect(s) "
            "make animated playback unsafe"
        )

    rendered = RenderedDeck(
        deck_id=deck_id(source_sha256),
        renderer=RendererInfo(version=request.renderer_version),
        slides=tuple(slides),
        assets=tuple({asset.relative_path: asset for asset in assets}.values()),
        fonts=extract_fonts(request.source, request.output_dir),
        timelines=tuple(timelines),
        mapping_issues=tuple(issues),
        animation_eligible=eligible,
        ineligible_reason=reason,
    )
    (request.output_dir / "render.json").write_text(
        json.dumps(
            rendered.model_dump(mode="json"),
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return rendered

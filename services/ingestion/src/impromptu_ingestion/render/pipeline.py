"""Render one deck into per-slide SVG, externalized assets, and animation timelines."""

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

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
from impromptu_ingestion.render.source import (
    RenderError,
    normalize_renderer_svg,
    private_note_fragments,
    slide_parts,
    slide_size_points,
    stamp_container_ids,
    strip_prologue,
)
from impromptu_ingestion.render.timing import parse_slide_timeline


@dataclass(frozen=True, slots=True)
class RenderRequest:
    """One deck render, with its converter injected so the binary stays replaceable."""

    source: Path
    output_dir: Path
    converter: SvgConverter
    renderer_version: str = "unknown"
    strict_mapping: bool = True


@dataclass(frozen=True, slots=True)
class _VerifiedSlide:
    """One slide that passed verification and is ready to be written."""

    key: str
    index: int
    svg: str
    assets: tuple[RenderAsset, ...]
    payloads: Mapping[str, bytes]
    timeline: SlideTimeline


def _require_empty_output(output_dir: Path) -> None:
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RenderError("output_directory_not_empty", f"{output_dir} already has contents")
    output_dir.mkdir(parents=True, exist_ok=True)


def _convert(request: RenderRequest) -> str:
    with TemporaryDirectory(prefix="impromptu-render-") as scratch:
        produced = request.converter.convert(request.source, Path(scratch))
        if not produced.is_file():
            raise RenderError("converter_produced_no_svg", "converter returned a missing path")
        return strip_prologue(produced.read_text(encoding="utf-8"))


def render_deck(request: RenderRequest) -> RenderedDeck:
    """Convert, verify, and publish one deck's render artifacts under the output directory."""
    if not request.source.is_file():
        raise RenderError("source_missing", f"{request.source} is not a file")
    _require_empty_output(request.output_dir)

    source_sha256 = hashlib.sha256(request.source.read_bytes()).hexdigest()
    parts = slide_parts(request.source)
    slide_svgs = split_slides(_convert(request))
    if len(slide_svgs) != len(parts):
        raise RenderError(
            "slide_count_mismatch",
            f"deck declares {len(parts)} slides but the renderer produced {len(slide_svgs)}",
        )

    width_points, height_points = slide_size_points(request.source)
    verified: list[_VerifiedSlide] = []
    issues: list[MappingIssue] = []

    # Verify every slide before writing anything: a deck that fails the gate must leave no artifact.
    for index, ((part_name, slide_xml), converted) in enumerate(
        zip(parts, slide_svgs, strict=True), 1
    ):
        raw_svg = normalize_renderer_svg(stamp_container_ids(converted, index))
        mapping = map_slide(slide_xml, raw_svg, index)
        issues.extend(mapping.issues)
        targets: dict[int, ResolvedTarget] = {target.shape_id: target for target in mapping.targets}
        key = slide_key(source_sha256, part_name)
        svg_text, slide_assets, payloads = externalize_assets(raw_svg)
        verified.append(
            _VerifiedSlide(
                key=key,
                index=index,
                svg=svg_text,
                assets=slide_assets,
                payloads=payloads,
                timeline=parse_slide_timeline(slide_xml, key, targets),
            )
        )

    leaked = [
        fragment
        for fragment in private_note_fragments(request.source)
        for slide in verified
        if fragment in slide.svg
    ]
    if leaked:
        raise RenderError(
            "speaker_notes_in_render",
            f"{len(leaked)} private note fragment(s) appear in the rendered public surface",
        )

    if issues and request.strict_mapping:
        raise RenderError(
            "slide_mapping_mismatch",
            "; ".join(f"{issue.code} at {issue.path}: {issue.detail}" for issue in issues[:5]),
        )

    slides: list[RenderedSlide] = []
    assets: list[RenderAsset] = []
    for slide in verified:
        write_assets(slide.assets, slide.payloads, request.output_dir)
        assets.extend(slide.assets)
        relative = f"slides/slide-{slide.index}.svg"
        destination = request.output_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(slide.svg, encoding="utf-8")
        slides.append(
            RenderedSlide(
                slide_key=slide.key,
                source_index=slide.index,
                relative_path=relative,
                content_sha256=hashlib.sha256(slide.svg.encode("utf-8")).hexdigest(),
                width_points=width_points,
                height_points=height_points,
            )
        )

    timelines = [slide.timeline for slide in verified]
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

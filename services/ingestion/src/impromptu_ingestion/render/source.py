"""Read the source deck and normalize the converter output before verification."""

import re
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from lxml import etree

_SLIDE_PART = re.compile(r"^ppt/slides/slide(\d+)\.xml$")
_NOTES_PART = re.compile(r"^ppt/notesSlides/notesSlide\d+\.xml$")
_A_TEXT = "{http://schemas.openxmlformats.org/drawingml/2006/main}t"
_MIN_LEAK_LENGTH = 4
_MAX_NOTE_FRAGMENTS = 2_000
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


def slide_parts(source: Path) -> tuple[tuple[str, bytes], ...]:
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


def slide_size_points(source: Path) -> tuple[float, float]:
    with ZipFile(source) as archive:
        try:
            presentation = archive.read("ppt/presentation.xml").decode("utf-8", "replace")
        except KeyError:
            return _DEFAULT_SLIDE_POINTS
    match = re.search(r'sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"', presentation)
    if match is None:
        return _DEFAULT_SLIDE_POINTS
    return (int(match[1]) / _EMU_PER_POINT, int(match[2]) / _EMU_PER_POINT)


def stamp_container_ids(svg_text: str, slide_index: int) -> str:
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


def strip_prologue(svg_text: str) -> str:
    """Drop the XML declaration and DOCTYPE so no DTD ever reaches the strict parsers.

    LibreOffice always emits an SVG 1.1 DOCTYPE. Removing the whole prologue keeps any
    internal entity subset out of the document instead of trusting a parser flag.
    """
    start = svg_text.find("<svg")
    if start < 0:
        raise RenderError("converter_produced_no_svg", "converter output has no svg element")
    return svg_text[start:]


def _text_runs(archive: ZipFile, name: str, limit: int) -> set[str]:
    if archive.getinfo(name).file_size > limit:
        raise RenderError("slide_xml_too_large", f"{name} exceeds the part size limit")
    root = etree.fromstring(
        archive.read(name),
        parser=etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False),
    )
    runs: set[str] = set()
    for element in root.iter(_A_TEXT):
        value = (element.text or "").strip()
        if len(value) >= _MIN_LEAK_LENGTH:
            runs.add(value)
    return runs


def private_note_fragments(source: Path) -> tuple[str, ...]:
    """Return note text that appears nowhere in the deck's own visible slide text.

    Only these fragments can prove a leak: a note that merely repeats what the slide
    already shows is not private, and matching it would refuse legitimate decks.
    """
    with ZipFile(source) as archive:
        names = archive.namelist()
        notes: set[str] = set()
        for name in names:
            if _NOTES_PART.match(name) is not None:
                notes |= _text_runs(archive, name, _MAX_SLIDE_XML_BYTES)
                if len(notes) > _MAX_NOTE_FRAGMENTS:
                    raise RenderError("notes_too_large", "deck declares too many note fragments")
        if not notes:
            return ()
        visible: set[str] = set()
        for name in names:
            if _SLIDE_PART.match(name) is not None:
                visible |= _text_runs(archive, name, _MAX_SLIDE_XML_BYTES)
    return tuple(sorted(notes - visible))

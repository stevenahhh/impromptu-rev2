"""Bounded LibreOffice SVG conversion and multi-slide SVG splitting."""

import copy
import os
import shutil
import subprocess
from pathlib import Path
from typing import Protocol
from xml.etree import ElementTree as ET

from impromptu_ingestion.render.svg_document import parse_untrusted_xml

_SVG_NS = "http://www.w3.org/2000/svg"
_XLINK_NS = "http://www.w3.org/1999/xlink"
ET.register_namespace("", _SVG_NS)
ET.register_namespace("xlink", _XLINK_NS)

_MAX_SVG_CHARACTERS = 16_000_000
_MAX_SVG_ELEMENTS = 250_000
_MAX_SLIDES = 1_000
_METADATA_CLASSES = frozenset(
    {"Background", "BackgroundObjects", "DateTime", "Footer", "PageNumber", "Header"}
)


class LibreOfficeConversionError(RuntimeError):
    """A machine-identifiable conversion or emitted-SVG failure."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


class SvgConverter(Protocol):
    """Injectable port for converting one supported source document to SVG."""

    def convert(self, source: Path, output_dir: Path) -> Path:
        """Convert source and return the path of the produced SVG document."""
        ...


class LibreOfficeSvgConverter:
    """Invoke a specific LibreOffice binary without involving a shell."""

    def __init__(self, soffice: Path, timeout_seconds: float = 60.0) -> None:
        if timeout_seconds <= 0:
            raise LibreOfficeConversionError(
                "invalid_conversion_timeout", "timeout must be positive"
            )
        self._soffice = soffice
        self._timeout_seconds = timeout_seconds

    def convert(self, source: Path, output_dir: Path) -> Path:
        output_dir.mkdir(parents=True, exist_ok=True)
        expected = output_dir / f"{source.stem}.svg"
        expected.unlink(missing_ok=True)
        try:
            result = subprocess.run(
                [
                    str(self._soffice),
                    "--headless",
                    "--norestore",
                    "--convert-to",
                    "svg",
                    "--outdir",
                    str(output_dir),
                    str(source),
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=self._timeout_seconds,
            )
        except subprocess.TimeoutExpired as error:
            raise LibreOfficeConversionError(
                "libreoffice_timeout", f"conversion exceeded {self._timeout_seconds:g} seconds"
            ) from error
        except OSError as error:
            raise LibreOfficeConversionError(
                "libreoffice_unavailable", f"could not execute LibreOffice: {error}"
            ) from error
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()[:500] or "no diagnostic output"
            raise LibreOfficeConversionError(
                "libreoffice_conversion_failed",
                f"LibreOffice exited with {result.returncode}: {detail}",
            )
        if not expected.is_file():
            raise LibreOfficeConversionError(
                "libreoffice_output_missing", f"LibreOffice did not create {expected.name}"
            )
        return expected


def discover_soffice() -> Path | None:
    """Locate LibreOffice using configuration, PATH, then standard Windows locations."""
    configured = os.environ.get("SOFFICE_PATH")
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured))
    on_path = shutil.which("soffice")
    if on_path:
        candidates.append(Path(on_path))
    candidates.extend(
        (
            Path(os.environ.get("PROGRAMFILES", r"C:\Program Files"))
            / "LibreOffice"
            / "program"
            / "soffice.exe",
            Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"))
            / "LibreOffice"
            / "program"
            / "soffice.exe",
        )
    )
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def converter_version(soffice: Path) -> str:
    """Return LibreOffice's display version, or ``unknown`` when it cannot be queried."""
    version_binary = soffice
    if soffice.suffix.lower() == ".exe" and soffice.with_suffix(".com").is_file():
        version_binary = soffice.with_suffix(".com")
    try:
        result = subprocess.run(
            [str(version_binary), "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except OSError, subprocess.TimeoutExpired:
        return "unknown"
    if result.returncode != 0:
        return "unknown"
    first_line = (result.stdout.strip() or result.stderr.strip()).splitlines()
    return first_line[0].strip()[:64] if first_line and first_line[0].strip() else "unknown"


def split_slides(svg_text: str) -> tuple[str, ...]:
    """Split LibreOffice's multi-page SVG into standalone, non-metadata-only slides."""
    if len(svg_text) > _MAX_SVG_CHARACTERS:
        raise LibreOfficeConversionError(
            "svg_too_large", "SVG exceeds the 16,000,000 character limit"
        )
    root = parse_untrusted_xml(svg_text, LibreOfficeConversionError, "invalid_svg", "SVG")
    preserve_xlink = f'xmlns:xlink="{_XLINK_NS}"' in svg_text
    elements = tuple(root.iter())
    if len(elements) > _MAX_SVG_ELEMENTS:
        raise LibreOfficeConversionError("svg_too_complex", "SVG element count exceeds limit")
    slide_nodes = tuple(node for node in elements if _has_class(node, "Slide"))
    if len(slide_nodes) > _MAX_SLIDES:
        raise LibreOfficeConversionError("too_many_slides", "SVG slide count exceeds limit")
    definitions = tuple(child for child in root if _local_name(child) == "defs")
    documents: list[str] = []
    for slide in slide_nodes:
        pages = tuple(node for node in slide.iter() if _has_class(node, "Page"))
        if not any(_page_has_drawing(page) for page in pages):
            continue
        standalone = ET.Element(root.tag, attrib=dict(root.attrib))
        standalone.text = root.text
        for definition in definitions:
            standalone.append(copy.deepcopy(definition))
        standalone.append(copy.deepcopy(slide))
        uses_xlink = any(
            any(name.startswith(f"{{{_XLINK_NS}}}") for name in node.attrib)
            for node in standalone.iter()
        )
        if preserve_xlink and not uses_xlink:
            standalone.set("xmlns:xlink", _XLINK_NS)
        documents.append(ET.tostring(standalone, encoding="unicode"))
    return tuple(documents)


def _has_class(element: ET.Element, class_name: str) -> bool:
    return class_name in element.get("class", "").split()


def _local_name(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _page_has_drawing(page: ET.Element) -> bool:
    return any(
        _local_name(child) != "g"
        or not set(child.get("class", "").split()).intersection(_METADATA_CLASSES)
        for child in page
    )

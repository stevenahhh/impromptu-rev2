import base64
import binascii
import hashlib
import re
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile, ZipInfo

from impromptu_ingestion.render.contracts import EmbeddedFont, RenderAsset
from impromptu_ingestion.render.svg_document import parse_untrusted_xml

_ALLOWED_MEDIA_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/svg+xml": "svg",
}
_DATA_URI = re.compile(r"^data:([^;,]+);base64,(.*)$", re.DOTALL)
_FONT_PART = re.compile(r"ppt/fonts/[^/]+\.fntdata$")
_MAX_SVG_CHARACTERS, _MAX_ASSETS = 16_000_000, 2_000
_MAX_ASSET_BYTES, _MAX_TOTAL_ASSET_BYTES = 16_000_000, 128_000_000
_MAX_ZIP_PARTS, _MAX_FONT_PARTS = 10_000, 128
_MAX_FONT_BYTES, _MAX_XML_BYTES = 8_000_000, 2_000_000
_A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
_P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


class AssetExternalizationError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


class FontExtractionError(AssetExternalizationError):
    pass


def externalize_assets(
    svg_text: str, assets_dir_name: str = "assets"
) -> tuple[str, tuple[RenderAsset, ...], Mapping[str, bytes]]:
    """Replace image data URIs and return SVG, contracts, and relative-path payloads."""
    asset_directory = PurePosixPath(assets_dir_name)
    unsafe_part = any(part in {"", ".", ".."} for part in asset_directory.parts)
    portable = re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,120}", assets_dir_name)
    if not assets_dir_name or asset_directory.is_absolute() or unsafe_part or portable is None:
        raise AssetExternalizationError(
            "asset_directory_invalid", "asset directory must be portable and relative"
        )
    if len(svg_text) > _MAX_SVG_CHARACTERS:
        raise AssetExternalizationError("svg_too_large", "SVG exceeds character limit")
    root = parse_untrusted_xml(svg_text, AssetExternalizationError, "invalid_svg", "SVG")
    assets_by_hash: dict[str, RenderAsset] = {}
    payloads: dict[str, bytes] = {}
    total_bytes = 0
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] != "image":
            continue
        for attribute_name, value in tuple(element.attrib.items()):
            if attribute_name.rsplit("}", 1)[-1] != "href" or not value.startswith("data:"):
                continue
            match = _DATA_URI.fullmatch(value)
            if match is None:
                raise AssetExternalizationError("asset_payload_invalid", "malformed data URI")
            media_type, encoded = match.groups()
            extension = _ALLOWED_MEDIA_TYPES.get(media_type.lower())
            if extension is None:
                raise AssetExternalizationError(
                    "asset_media_type_unsupported", f"unsupported data URI media type: {media_type}"
                )
            try:
                payload = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as error:
                raise AssetExternalizationError(
                    "asset_payload_invalid", "data URI contains invalid base64"
                ) from error
            if not payload or len(payload) > _MAX_ASSET_BYTES:
                raise AssetExternalizationError(
                    "asset_size_invalid", "decoded asset is empty or exceeds the size limit"
                )
            digest = hashlib.sha256(payload).hexdigest()
            existing = assets_by_hash.get(digest)
            if existing is None:
                if len(assets_by_hash) >= _MAX_ASSETS:
                    raise AssetExternalizationError(
                        "too_many_assets", "SVG asset count exceeds limit"
                    )
                total_bytes += len(payload)
                if total_bytes > _MAX_TOTAL_ASSET_BYTES:
                    raise AssetExternalizationError(
                        "asset_total_too_large", "decoded SVG assets exceed aggregate limit"
                    )
                relative_path = f"{assets_dir_name}/asset_{digest}.{extension}"
                existing = RenderAsset(
                    relative_path=relative_path,
                    media_type=media_type.lower(),
                    content_sha256=digest,
                    byte_size=len(payload),
                )
                assets_by_hash[digest] = existing
                payloads[relative_path] = payload
            element.set(attribute_name, existing.relative_path)
    rewritten = ET.tostring(root, encoding="unicode")
    if "data:image" in rewritten:
        raise AssetExternalizationError(
            "asset_externalization_incomplete", "rewritten SVG still contains image data"
        )
    return rewritten, tuple(assets_by_hash.values()), payloads


def write_assets(
    assets: tuple[RenderAsset, ...], payloads: Mapping[str, bytes], output_dir: Path
) -> None:
    root = output_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    for asset in assets:
        payload = payloads.get(asset.relative_path)
        if payload is None:
            raise AssetExternalizationError(
                "asset_payload_missing", f"no bytes supplied for {asset.relative_path}"
            )
        digest = hashlib.sha256(payload).hexdigest()
        if digest != asset.content_sha256 or len(payload) != asset.byte_size:
            raise AssetExternalizationError(
                "asset_payload_mismatch", f"bytes do not match contract for {asset.relative_path}"
            )
        destination = (root / Path(asset.relative_path)).resolve()
        if not destination.is_relative_to(root):
            raise AssetExternalizationError(
                "asset_path_escape", f"asset path escapes output directory: {asset.relative_path}"
            )
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(payload)


def extract_fonts(pptx_path: Path, output_dir: Path) -> tuple[EmbeddedFont, ...]:
    try:
        with ZipFile(pptx_path) as archive:
            infos = archive.infolist()
            if len(infos) > _MAX_ZIP_PARTS:
                raise FontExtractionError("pptx_too_many_parts", "PPTX part count exceeds limit")
            font_infos = tuple(info for info in infos if _FONT_PART.fullmatch(info.filename))
            if len(font_infos) > _MAX_FONT_PARTS:
                raise FontExtractionError(
                    "too_many_font_parts", "embedded font count exceeds limit"
                )
            if any(info.file_size > _MAX_FONT_BYTES for info in font_infos):
                raise FontExtractionError("font_part_too_large", "embedded font part exceeds limit")
            embedded = _embedded_font_bindings(archive, font_infos)
            theme_families = _theme_font_families(archive, infos)
            root = output_dir.resolve()
            root.mkdir(parents=True, exist_ok=True)
            results: list[EmbeddedFont] = []
            used_paths: set[str] = set()
            for family, info in embedded:
                relative_path = _font_relative_path(family, info, used_paths)
                payload = _bounded_read(archive, info)
                destination = (root / Path(relative_path)).resolve()
                if not destination.is_relative_to(root):
                    raise FontExtractionError("font_path_escape", "font path escapes output")
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(payload)
                results.append(
                    EmbeddedFont(family=family, relative_path=relative_path, embedded=True)
                )
            embedded_families = {font.family.casefold() for font in results}
            for family in sorted(theme_families, key=str.casefold):
                if family.casefold() not in embedded_families:
                    results.append(EmbeddedFont(family=family, embedded=False))
            return tuple(results)
    except FontExtractionError:
        raise
    except (BadZipFile, OSError, KeyError) as error:
        raise FontExtractionError(
            "pptx_archive_invalid", f"cannot inspect PPTX fonts: {error}"
        ) from error


def _bounded_read(archive: ZipFile, part: str | ZipInfo) -> bytes:
    info = archive.getinfo(part) if isinstance(part, str) else part
    is_font = _FONT_PART.fullmatch(info.filename) is not None
    if info.file_size > _MAX_XML_BYTES and not is_font:
        raise FontExtractionError("pptx_xml_too_large", f"XML part exceeds limit: {info.filename}")
    if info.file_size > _MAX_FONT_BYTES and is_font:
        raise FontExtractionError("font_part_too_large", "embedded font part exceeds limit")
    payload = archive.read(info)
    limit = _MAX_FONT_BYTES if is_font else _MAX_XML_BYTES
    if len(payload) > limit:
        raise FontExtractionError(
            "pptx_part_too_large", f"expanded part exceeds limit: {info.filename}"
        )
    return payload


def _xml_root(archive: ZipFile, name: str) -> ET.Element:
    return parse_untrusted_xml(
        _bounded_read(archive, name), FontExtractionError, "pptx_xml_unsafe", name
    )


def _embedded_font_bindings(
    archive: ZipFile, font_infos: tuple[ZipInfo, ...]
) -> tuple[tuple[str, ZipInfo], ...]:
    names = {info.filename: info for info in font_infos}
    if "ppt/presentation.xml" not in archive.namelist():
        return ()
    presentation = _xml_root(archive, "ppt/presentation.xml")
    relationships = _xml_root(archive, "ppt/_rels/presentation.xml.rels")
    targets = {
        node.get("Id", ""): f"ppt/{node.get('Target', '')}"
        for node in relationships.findall(f"{{{_REL_NS}}}Relationship")
    }
    bindings: list[tuple[str, ZipInfo]] = []
    for embedded in presentation.findall(f".//{{{_P_NS}}}embeddedFont"):
        font = embedded.find(f"{{{_P_NS}}}font")
        family = font.get("typeface", "").strip() if font is not None else ""
        if not family or len(family) > 128:
            continue
        for variant in embedded:
            relationship_id = variant.get(f"{{{_R_NS}}}id")
            target = targets.get(relationship_id or "")
            if target in names:
                bindings.append((family, names[target]))
    return tuple(bindings)


def _theme_font_families(archive: ZipFile, infos: list[ZipInfo]) -> set[str]:
    families: set[str] = set()
    for info in infos:
        if not info.filename.startswith("ppt/theme/") or not info.filename.endswith(".xml"):
            continue
        root = _xml_root(archive, info.filename)
        for node in root.findall(f".//{{{_A_NS}}}fontScheme//*[@typeface]"):
            family = node.get("typeface", "").strip()
            if family and not family.startswith("+") and len(family) <= 128:
                families.add(family)
    return families


def _font_relative_path(family: str, info: ZipInfo, used: set[str]) -> str:
    safe_family = re.sub(r"[^A-Za-z0-9._-]+", "_", family).strip("._-") or "font"
    candidate = f"fonts/{safe_family}.fntdata"
    if candidate in used:
        candidate = f"fonts/{safe_family}_{Path(info.filename).stem}.fntdata"
    used.add(candidate)
    return candidate

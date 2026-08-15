import base64
import hashlib
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from impromptu_ingestion.render.assets import (
    AssetExternalizationError,
    FontExtractionError,
    externalize_assets,
    extract_fonts,
    write_assets,
)
from impromptu_ingestion.render.contracts import RenderAsset


def _data_uri(media_type: str, payload: bytes) -> str:
    return f"data:{media_type};base64,{base64.b64encode(payload).decode()}"


def test_externalize_assets_rewrites_deduplicates_and_returns_payloads() -> None:
    png = b"\x89PNG\r\n\x1a\nfixture"
    jpeg = b"\xff\xd8\xfffixture"
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg"
      xmlns:xlink="http://www.w3.org/1999/xlink">
      <image id="one" xlink:href="{_data_uri("image/png", png)}"/>
      <image id="duplicate" href="{_data_uri("image/png", png)}"/>
      <image id="two" href="{_data_uri("image/jpeg", jpeg)}"/>
    </svg>"""

    rewritten, assets, payloads = externalize_assets(svg)

    png_hash = hashlib.sha256(png).hexdigest()
    jpeg_hash = hashlib.sha256(jpeg).hexdigest()
    assert "data:image" not in rewritten
    assert rewritten.count(f"assets/asset_{png_hash}.png") == 2
    assert f"assets/asset_{jpeg_hash}.jpg" in rewritten
    assert tuple(asset.content_sha256 for asset in assets) == (png_hash, jpeg_hash)
    assert payloads == {
        f"assets/asset_{png_hash}.png": png,
        f"assets/asset_{jpeg_hash}.jpg": jpeg,
    }


def test_externalize_assets_rejects_unsafe_media_and_bad_base64() -> None:
    for uri, code in (
        (_data_uri("text/html", b"bad"), "asset_media_type_unsupported"),
        ("data:image/png;base64,%%%", "asset_payload_invalid"),
    ):
        svg = f'<svg xmlns="http://www.w3.org/2000/svg"><image href="{uri}"/></svg>'
        with pytest.raises(AssetExternalizationError) as raised:
            externalize_assets(svg)
        assert raised.value.code == code


def test_write_assets_creates_files_and_refuses_traversal(tmp_path: Path) -> None:
    payload = b"image"
    digest = hashlib.sha256(payload).hexdigest()
    asset = RenderAsset(
        relative_path=f"assets/asset_{digest}.png",
        media_type="image/png",
        content_sha256=digest,
        byte_size=len(payload),
    )
    write_assets((asset,), {asset.relative_path: payload}, tmp_path)
    assert (tmp_path / asset.relative_path).read_bytes() == payload

    forged = asset.model_copy(update={"relative_path": "../escaped.png"})
    with pytest.raises(AssetExternalizationError) as raised:
        write_assets((forged,), {"../escaped.png": payload}, tmp_path)
    assert raised.value.code == "asset_path_escape"


def _write_font_deck(path: Path) -> None:
    presentation = """<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <p:embeddedFontLst><p:embeddedFont><p:font typeface="Embedded Family"/>
      <p:regular r:id="rIdFont"/></p:embeddedFont></p:embeddedFontLst>
    </p:presentation>"""
    relationships = """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdFont" Target="fonts/font1.fntdata"
       Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"/>
    </Relationships>"""
    theme = """<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:themeElements><a:fontScheme name="Fixture"><a:majorFont>
      <a:latin typeface="Embedded Family"/></a:majorFont><a:minorFont>
      <a:latin typeface="Theme Only"/><a:font script="Hang" typeface="Supplemental"/>
      </a:minorFont></a:fontScheme></a:themeElements>
    </a:theme>"""
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("ppt/presentation.xml", presentation)
        archive.writestr("ppt/_rels/presentation.xml.rels", relationships)
        archive.writestr("ppt/theme/theme1.xml", theme)
        archive.writestr("ppt/fonts/font1.fntdata", b"opaque-font")


def test_extract_fonts_writes_embedded_and_reports_theme_only_fonts(tmp_path: Path) -> None:
    source = tmp_path / "fonts.pptx"
    _write_font_deck(source)

    fonts = extract_fonts(source, tmp_path / "render")

    assert [(font.family, font.embedded) for font in fonts] == [
        ("Embedded Family", True),
        ("Supplemental", False),
        ("Theme Only", False),
    ]
    embedded = fonts[0]
    assert embedded.relative_path == "fonts/Embedded_Family.fntdata"
    assert (tmp_path / "render" / embedded.relative_path).read_bytes() == b"opaque-font"


def test_extract_fonts_rejects_invalid_archives_and_oversized_parts(tmp_path: Path) -> None:
    invalid = tmp_path / "invalid.pptx"
    invalid.write_bytes(b"not a zip")
    with pytest.raises(FontExtractionError) as raised:
        extract_fonts(invalid, tmp_path / "out")
    assert raised.value.code == "pptx_archive_invalid"

    oversized = tmp_path / "oversized.pptx"
    with ZipFile(oversized, "w", ZIP_DEFLATED) as archive:
        archive.writestr("ppt/fonts/font1.fntdata", b"x" * 8_000_001)
    with pytest.raises(FontExtractionError) as raised:
        extract_fonts(oversized, tmp_path / "out")
    assert raised.value.code == "font_part_too_large"

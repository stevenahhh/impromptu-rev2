import json
from pathlib import Path

import pytest
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches

from impromptu_ingestion.cli import main


@pytest.fixture
def simple_deck(tmp_path: Path) -> Path:
    path = tmp_path / "발표.pptx"
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    shape = slide.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1), Inches(1), Inches(3), Inches(2)
    )
    shape.text_frame.text = "한국어"
    presentation.save(path)
    return path


def _requires_libreoffice() -> bool:
    from impromptu_ingestion.render.libreoffice import discover_soffice

    return discover_soffice() is None


def test_render_reports_the_missing_renderer_instead_of_pretending(
    simple_deck: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr("impromptu_ingestion.cli.discover_soffice", lambda: None)

    exit_code = main(["render", str(simple_deck), "--output-dir", str(tmp_path / "out")])

    assert exit_code == 2
    assert "renderer_not_configured" in capsys.readouterr().err


@pytest.mark.skipif(_requires_libreoffice(), reason="LibreOffice is not installed")
def test_render_publishes_artifacts_a_manifest_and_a_summary(
    simple_deck: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    output_dir = tmp_path / "out"

    exit_code = main(["render", str(simple_deck), "--output-dir", str(output_dir)])

    assert exit_code == 0
    manifest = json.loads((output_dir / "render.json").read_text(encoding="utf-8"))
    assert manifest["slides"], "the manifest must list rendered slides"
    slide_svg = (output_dir / manifest["slides"][0]["relative_path"]).read_text(encoding="utf-8")
    assert "data:image" not in slide_svg
    assert "rendered" in capsys.readouterr().out


@pytest.mark.skipif(_requires_libreoffice(), reason="LibreOffice is not installed")
def test_render_refuses_a_non_empty_output_directory(simple_deck: Path, tmp_path: Path) -> None:
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    (output_dir / "existing.txt").write_text("keep", encoding="utf-8")

    assert main(["render", str(simple_deck), "--output-dir", str(output_dir)]) == 2
    assert (output_dir / "existing.txt").read_text(encoding="utf-8") == "keep"


def test_doctor_json_reports_renderer_availability(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["doctor", "--json"]) in (0, 1)

    report = json.loads(capsys.readouterr().out)
    rendering = report["rendering"]
    assert rendering["status"] in ("configured", "not_configured")
    assert isinstance(rendering["renderer"], str | None)

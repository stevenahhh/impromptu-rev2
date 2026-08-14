from impromptu_ingestion.canonical import canonical_manifest_bytes, manifest_sha256
from impromptu_ingestion.contracts import (
    DeckManifest,
    InputKind,
    RenderBoundary,
    SlideManifest,
    TextElement,
)


def _manifest() -> DeckManifest:
    return DeckManifest(
        deck_id="deck_" + "a" * 64,
        source_sha256="a" * 64,
        source_kind=InputKind.PDF,
        adapter_version="pymupdf-structural-v1",
        slides=(
            SlideManifest(
                slide_key="slide_" + "b" * 64,
                source_index=1,
                source_id="page:1",
                width_points=960,
                height_points=540,
                elements=(
                    TextElement(
                        element_id="text:1",
                        text="결정적 evidence",
                        x=10,
                        y=20,
                        width=100,
                        height=30,
                    ),
                ),
            ),
        ),
        render_boundary=RenderBoundary.structural_only(),
    )


def test_canonical_manifest_is_utf8_sorted_compact_json() -> None:
    encoded = canonical_manifest_bytes(_manifest())

    assert encoded.startswith(b'{"adapter_version":')
    assert b'": ' not in encoded
    assert b", " not in encoded
    assert "결정적".encode() in encoded
    assert encoded.endswith(b"}\n")


def test_manifest_hash_is_repeatable_and_content_addressed() -> None:
    first = _manifest()
    second = DeckManifest.model_validate(first.model_dump(mode="json"))

    assert manifest_sha256(first) == manifest_sha256(second)
    assert len(manifest_sha256(first)) == 64

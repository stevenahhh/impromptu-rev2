# Format-neutral Korean deck fixtures

These three synthetic fixtures freeze the common `DeckManifest` input semantics used by the PDF,
PPTX, retrieval, report, and later OCR tracks. Their canonical hashes, pinned density invariants,
and per-file provenance are in `fixture-manifest.json`.

The existing `docs/samples/impromptu-sample-deck.pptx` is intentionally not reused here. It is a
seven-slide product demo whose PDF export depends on a local LibreOffice binary. This fixture set
instead uses a purpose-built PPTX so both structural formats contain exactly the same ordered
Korean text and regeneration is independent of LibreOffice.

Each fixture is a six-slide Korean business deck (company: 한빛유통) whose body carries concrete,
verbatim fact tokens — figures (`482억 원`, `23%`, `12,400명`), periods (`2025년`, `2026년 3월`),
and proper nouns (`단비`, `모아마켓`) — so grounded recommendations can cite facts that the
deterministic evidence gate can reconcile against the source text. The OCR sentinel line
`형식 중립 근거 자료 2026` remains exactly the first slide title of every fixture; density was
added only around it.

Regenerate from the repository root with the PEP 723-pinned generator:

```bash
uv run scripts/generate-format-neutral-deck-fixtures.py
```

The generator normalizes OOXML ZIP metadata, fixes document metadata, and saves PDFs without random
file IDs. Regeneration without a generator change leaves all three SHA-256 values unchanged; a
generator content change updates them together with the registry hashes and density pins.

Fixture semantics:

- `korean-structural.pptx`: six slides, one native textbox per line (24 TextElements).
- `korean-text-layer.pdf`: the same six slides as native PDF text spans with an identical ordered
  TextElement tuple.
- `korean-scanned.pdf`: 2x raster images of those same six pages with no PDF text layer; the
  current PDF adapter must emit `scanned_page_requires_ocr`, and OCR must restore the sentinel line
  exactly on slide one.

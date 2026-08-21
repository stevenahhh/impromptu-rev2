# Format-neutral Korean deck fixtures

These three synthetic fixtures freeze the common `DeckManifest` input semantics used by the PDF,
PPTX, retrieval, report, and later OCR tracks. Their canonical hashes and per-file provenance are in
`fixture-manifest.json`.

The existing `docs/samples/impromptu-sample-deck.pptx` is intentionally not reused here. It is a
seven-slide product demo whose PDF export depends on a local LibreOffice binary. This fixture set
instead uses a minimal, purpose-built PPTX so both structural formats contain exactly the same Korean
sentinel and regeneration is independent of LibreOffice.

Regenerate from the repository root with the PEP 723-pinned generator:

```bash
uv run scripts/generate-format-neutral-deck-fixtures.py
```

The generator normalizes OOXML ZIP metadata, fixes document metadata, and saves PDFs without random
file IDs. A valid regeneration leaves all three SHA-256 values unchanged.

Fixture semantics:

- `korean-structural.pptx`: one native text shape containing the structural sentinel.
- `korean-text-layer.pdf`: one native PDF text span containing the same structural sentinel.
- `korean-scanned.pdf`: a raster-only page showing the OCR sentinel, with no PDF text layer; the
  current PDF adapter must emit `scanned_page_requires_ocr`.

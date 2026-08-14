# Ingestion worker

Python 3.14 server/local-admin worker for deterministic structural extraction from PPTX and PDF.

```bash
uv sync --project services/ingestion
uv run --project services/ingestion impromptu-ingestion --help
uv run --project services/ingestion impromptu-ingestion doctor --json
uv run --project services/ingestion impromptu-ingestion ingest deck.pdf --output manifest.json
```

The worker validates local regular files, fingerprints source bytes, and emits a closed Pydantic
manifest with content-addressed deck and slide identities. PPTX extraction includes public slide
text, tables, images, and chart series; speaker notes are never read into the manifest. PDF
extraction includes positioned text and embedded images.

This increment is structural-only. It does not invoke LibreOffice, rasterize slides, verify visual
fidelity, run OCR/VLM/AI, or load provider credentials. Scanned PDF pages and unsupported PPTX
shapes produce explicit warnings. Rendering remains `not_configured` until a real renderer is
separately integrated and tested.

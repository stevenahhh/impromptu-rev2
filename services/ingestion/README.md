# Ingestion worker

Python 3.14 server/local-admin worker for deterministic structural extraction from PPTX and PDF.

```bash
uv sync --project services/ingestion
uv run --project services/ingestion impromptu-ingestion --help
uv run --project services/ingestion impromptu-ingestion doctor --json
uv run --project services/ingestion impromptu-ingestion ingest deck.pdf --output manifest.json
```

The installed executable is `impromptu-ingestion`. The worker copies one stable source snapshot
into a private temporary directory, hashes and validates that staged copy, and parses exactly those
bytes. Source replacement during staging is rejected. Completed output is written and fsynced
through its original `mkstemp` descriptor, identity/link-count checked, and atomically published
from a unique sibling path without replacing an existing regular path or symlink.

PPTX extraction includes public slide text, tables, images, and chart series; speaker notes are
never read into the manifest. PDF extraction includes positioned text and embedded images. PDF
parsing runs in a bounded child process with a 30-second default deadline, strict EOF and
cross-reference validation, MuPDF diagnostic rejection, and explicit page, object, element,
resource-byte, and image-pixel limits.

This increment is structural-only. It does not invoke LibreOffice, rasterize slides, verify visual
fidelity, run OCR/VLM/AI, or load provider credentials. Scanned PDF pages and unsupported PPTX
shapes produce explicit warnings. Rendering remains `not_configured` until a real renderer is
separately integrated and tested.

## Verification history

Commits `3651893`, `3babf0b`, and `7ff248a` are preserved historical increments and were not
full-gate green after a fresh `uv sync`; their ingestion-integrity gaps were found by independent
verification. History was not amended or rebased. Later corrective commits add immutable staging,
strict bounded PDF processing, and interruption-safe atomic output publication.

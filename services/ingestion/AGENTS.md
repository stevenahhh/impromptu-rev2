# INGESTION SERVICE GUIDE

## OVERVIEW

Python 3.14/uv worker for deterministic PPTX/PDF structural extraction and verified SVG/timeline
rendering; no OCR, VLM, or other AI execution.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| CLI and atomic output | `src/impromptu_ingestion/cli.py` | Typed errors, no-replace publication |
| Input staging/dispatch | `src/impromptu_ingestion/worker.py` | Immutable source copy |
| Contracts/canonical form | `contracts.py`, `canonical.py` | Closed models and stable hashes |
| PPTX/PDF parsing | `adapters/`, `pdf_worker.py` | Archive/XML/process limits |
| Render pipeline | `src/impromptu_ingestion/render/` | Mapping, assets, note-leak gate |
| Tests and fixtures | `tests/` | Temporary realistic documents |

## CONVENTIONS

- Use closed, frozen Pydantic models and deterministic sorted compact JSON plus trailing newline.
- Stage and validate local regular-file input; parse only the immutable staged copy.
- Assign stable machine-readable error codes at every external boundary.
- Bound archives, XML, SVG, assets, subprocess time/resources, and output paths.
- Render verifies every slide and note-leak/mapping condition before publishing artifacts.
- Tests use `tmp_path`, generated PPTX/PDF fixtures, injected converters, and refusal assertions.
- Optional real-LibreOffice integration may skip when LibreOffice is unavailable.

## ANTI-PATTERNS

- Never overwrite output paths or expose partial/unverified artifacts.
- Never read speaker notes into manifests or rendered public output.
- Never invoke subprocesses through a shell or remove explicit timeouts.
- Never permit XML `DOCTYPE`/`ENTITY`, unsafe ZIP members, or path escapes.
- Never weaken content hashes, resource limits, or error codes without matching contract tests.

## CHECKS

```bash
uv sync --project services/ingestion
uv run --project services/ingestion pytest
uv run --project services/ingestion ruff check src tests
uv run --project services/ingestion basedpyright
uv run --project services/ingestion impromptu-ingestion doctor
```

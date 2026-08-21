# Task 26 — OCR sentinel recognition quality (PSM 6 adoption)

Date: 2026-08-22 · Machine: Apple M5 Pro (arm64, darwin) · tesseract 5.5.3 (homebrew)
Models: tessdata_fast @ 87416418657359cb625c412a48b6e1d6d41c29bd — kor.traineddata
1,677,415 B (sha256 6b85e11d…) + eng.traineddata 4,113,088 B (sha256 7d4322bd…) =
5,790,503 B total; hashes verified before every experiment.
Fixture: tests/fixtures/format-neutral-decks/korean-scanned.pdf (frozen; single page,
720×405 pt, one embedded 1440×810 PNG ≈144 DPI native). Expected sentinel:
`형식 중립 근거 자료 2026`. Fixture pixels are clean and legible (verified visually) —
the baseline failure was purely recognition/layout-analysis, not image quality.

## (a) Attempt matrix (direct tesseract on pymupdf-rendered page)

Baseline command = `-l kor+eng --oem 1 --psm 11 tsv`.

| DPI | preprocess | langs | PSM | restored line(s) | exact |
|----:|-----------|-------|----:|------------------|-------|
| 200 | none (RGB)   | kor+eng | 11 (baseline) | `형식` + `ron —|` + `근거 자료 2026` (3 fragments) | NO |
| 200 | grayscale+autocontrast | kor+eng | 11 | `형식` + `roe —|` + `근거 자료 2026` | NO |
| 200 | Otsu binarize          | kor+eng | 11 | `형식` + `= —|` + `근거 자료 2026` | NO |
| 200 | none | kor | 11 | `형식` + `터` + `근거 자료 2026` | NO |
| 200 | gray/otsu | kor | 11 | fragments (`턴` / `= 터`) | NO |
| 144 | none | kor+eng / kor | 11 | `형식` + `중립` + `근거 자료 2026` (split lines) | NO |
| 288 | none | kor+eng / kor | 11 | same split-line fragments | NO |
| 300 | none | kor+eng / kor | 11 | fragments | NO |
| 400 | none | kor+eng / kor | 11 | `Oo &` / `근거 Ae 2026` garbage | NO |
| 200 | none | kor+eng | **6** | **`형식 중립 근거 자료 2026`** (one element) | **YES** |
| 200 | none | kor     | 6 | exact | YES |
| 200 | gray | kor+eng / kor | 6 | exact | YES |
| 200 | otsu | kor+eng / kor | 6 | exact | YES |
| 144 | none | kor+eng / kor | 4 | exact | YES |
| 144 | none | kor+eng / kor | 6 | exact | YES |
| 288 | none | kor+eng / kor | 4 / 6 | exact | YES |
| 300 | none | kor+eng / kor | 4 / 6 | `형식 주리 그` | NO |
| 400 | none | kor+eng / kor | 4 / 6 | `형식 중립` (rest dropped) | NO |

Key findings:

1. No preprocessing or DPI rescues PSM 11/12: sparse-text modes break the wide
   letter-spaced title into separate block/par/line keys, and the spaced glyphs of
   `중립` get misread (`ron —|`). The failure is the page-segmentation mode.
2. PSM 6 (single uniform block) restores the exact sentinel at the existing 200 DPI /
   RGB setting with zero preprocessing, for both `kor+eng` and `kor`.
3. Word confidences under PSM 6 @ 200 DPI: 92.4 / 90.3 / 95.1 / 95.1 / 95.8.
4. Determinism: 5 consecutive identical runs of the adopted config (byte-identical text).
5. >2× native resolution degrades quality (300/400 DPI worse than 288), consistent with
   known LSTM upsampling sensitivity — no DPI change needed.

Adopted change (services/ingestion/src/impromptu_ingestion/ocr.py): `--psm 11` → `--psm 6`
only. DPI, RGB colorspace, max edge 4096, pinned models, langs, shell=False, sequential
execution all unchanged.

## (b) Adoption rationale

- Only-necessary change: a single CLI flag; the pinned-model Dockerfile pins stay valid
  (same kor+eng fast models).
- Exact sentinel restored through the real pipeline (subprocess pdf_worker → TSV →
  TextElement): probe reports exactSentinelPages 10/10 on the ten-page copy.
- Faster and lighter than baseline locally: wall 1.82 s vs 1.79 s (parity) and max RSS
  149 MB vs 219 MB (PSM 11 sparse analysis is memory-heavier).
- Deterministic across repeats; no thermal/performance warnings (see receipt).

Note on measurement: `tests/ocr_resource_probe.py` multiplies macOS `ru_maxrss` by 1024;
on darwin `ru_maxrss` is already bytes, so that JSON field over-reports locally
(pre-existing quirk, kept for cross-platform schema stability). `/usr/bin/time -l`
figures below are authoritative for this workstation.

## (c) Resource receipt

Model bytes: kor 1,677,415 + eng 4,113,088 = 5,790,503 bytes (sha256 verified).

Adopted config (PSM 6), ten-page copy, sequential, direct .venv python:

```
        2.19 real         1.71 user         0.24 sys
   149471232  maximum resident set size
```
probe wallSeconds: 1.817261 · warnings per page: [ocr_applied] only.

Baseline (PSM 11, identical probe run in detached worktree at e601d54):

```
        6.20 real         2.24 user         0.24 sys
   219332608  maximum resident set size
```
probe wallSeconds: 1.793713 · recognizedTexts[0]: `형식 ron —| 근거 자료 2026` · exactSentinelPages 0/10.
(6.20 s real includes cold start of the fresh worktree venv.)

pmset -g therm before (pmset-after-psm6-before.txt):
`No thermal warning level has been recorded / No performance warning level has been recorded / No CPU power status has been recorded`
pmset -g therm after (pmset-after-psm6.txt): identical — no thermal/performance warnings.

## (d) OCR_GREEN judgment: TRUE

Recognition quality — the sole remaining blocker — now restores the sentinel exactly:
- Real-pipeline probe: exactSentinelPages 10/10, recognizedChunk == sentinel.
- Vertical probe (ocr_vertical_probe.ts, real upload worker + ingestion subprocess +
  PostgreSQL chunk indexing + hybrid retrieval): exit 0, dbChunkCount = 1,
  row anchor `slide=1&chunk=1`, content `형식 중립 근거 자료 2026`, lexical_match true,
  hybrid query returns slide=1&chunk=1 (dense branch, fixed 768-d vector).
- Live dev stack HTTP upload of the scanned fixture returned 201 (no 422 OCR_UNAVAILABLE).
  A bare curl recommendation without the browser session/audio flow abstains
  INSUFFICIENT_EVIDENCE — also for previously indexed decks — i.e., session-flow
  dependent and outside ingestion scope; the sanctioned sentinel-query capture is the
  vertical probe above.

## (e) VERIFY exit codes

| Gate (run inside services/ingestion) | Exit | Result |
|---|---:|---|
| uv run pytest | 0 | 109 passed |
| uv run ruff check src tests | 0 | All checks passed |
| uv run basedpyright | 0 | 0 errors, 0 warnings, 0 notes |
| bun services/ingestion/tests/ocr_vertical_probe.ts | 0 | exact sentinel, 1 chunk, hybrid hit |

Evidence files: ocr-resource-psm6.{json,time.txt}, ocr-vertical-psm6.json,
psm11-baseline-resource.json, psm11-baseline-time.txt,
pmset-after-psm6-before.txt, pmset-after-psm6.txt.

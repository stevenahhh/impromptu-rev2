# Demo and acceptance scope

## Terminology

- **First demo:** curated, pre-approved evidence reveal. This is not the final MVP.
- **Guarded-pilot MVP:** both secure display modes, private live recommendations, and a feature-flagged supervised path from an eligible live candidate to the public Stage.
- **Deferred enhancement:** automatic display placement, public live evidence before its gates, coaching, and generated report summaries.

## Supported environment

- Windows 11
- current stable Chrome and Edge
- wired Extend
- Duplicate with a separate private controller
- single-screen public Stage fallback

Manual Stage placement and a Stage-local fullscreen click are canonical. Browser Window Management is an optional enhancement.

## Secure display baseline

Both Extend and Duplicate use:

1. a clean public Stage browser profile on the presentation machine;
2. an already authenticated private controller on another device;
3. a short-lived, non-authorizing display join locator;
4. server-side display binding and an AudienceDisplaySession.

A co-resident Console in Extend mode is convenience-only and has no no-private-pixel claim.

## Preregistered evaluation

Before unblinding a frozen acceptance corpus, record:

- corpus hash and sampling frame;
- claim class and severity taxonomy;
- semantic acoustic endpoints;
- network and cache profile;
- formulas, thresholds, exclusions, and failure treatment;
- evaluator and rubric versions.

Development, provider bake-off, and acceptance data are disjoint by claim/paraphrase, source version, speaker recording, and deck instance.

Provisional live recommendation gates:

- semantic-audio-end to eligible Console render p95 <= 5 seconds;
- at most 3 results;
- eligible yield >= 60% for supportable, fetchable claims;
- direct top-3 usefulness >= 80% for answerable events;
- abstention >= 95% for intentionally unanswerable events;
- zero critical numeric, date, entity, and security escapes;
- at least 299 representative non-supportable cases with zero false-support escapes.

Live public evidence remains off until the signed evaluation record passes every applicable safety, usefulness, approval-load, lease, and recovery gate.

## 48-hour observable acceptance vs. September hardening

The five-feature compressed merge-train plan (`.omo/plans/impromptu-five-features-48h.md`) asked
the user to choose, before execution, whether the 48-hour window itself would be treated as the
completion boundary (`guarded-48h`) or whether September system-integration hardening would be
folded into that boundary (`include-hardening`). The user's recorded decision is
**`include-hardening`** (`.omo/evidence/decisions/completion-boundary.json`, decided 2026-08-21).

Consequences of that decision, stated explicitly so this document cannot be read as a completion
claim it does not make:

- **48-hour completion is not declared.** This document does not assert that the guarded 48-hour
  acceptance is complete, and the expanded five-feature request is not marked done.
- **Completion is held open**, deferred to the September hardening pass. It becomes assertable
  only when `CORE5_GREEN`, `OCR_GREEN`, `COACHING_WORD_TIMING_GREEN`, and `STAGE_ZERO_CARDS` are
  each independently true (see plan "Owner-input gates" and final receipt section) — `OCR_GREEN`
  is now `true` (below), but `CORE5_GREEN` is still `false`, so that bar is not yet met.
- **The 48-hour constraint is lifted.** Work on core-5, OCR, coaching, and the report is not cut
  off at the 48-hour mark to force a same-day completion claim; it continues under normal
  engineering cadence into the September hardening pass.

### What the 48-hour window produced (evidence-backed, not a completion claim)

- Core-5 functional wiring (local Korean STT, external evidence search, lexical+dense retrieval,
  real-time coaching, post-presentation report) exists and is exercised end-to-end; positive
  `RECOMMEND` outcomes remain non-deterministic under real chat providers
  (`.omo/evidence/task-29/abstain-root-cause.json`, `.omo/evidence/task-25/core5-run-summary.json`)
  and that gap is not closed by this document.
- Performance regression measurement (task-27, `.omo/evidence/task-27/performance-and-scope.json`):
  two independent 10-run cohorts against real chat/embedding providers and the real local
  whisper.cpp adapter, both 10/10 HTTP-complete with p95 <= 5,000ms — confirmed-FINAL-to-Console
  recommendation (SSE audio-ingest auto-trigger) p50 4,027.3ms / p95 4,503.8ms, and the existing
  direct `/v1/recommendations` flow p50 3,122.7ms / p95 4,505.0ms. Both cohorts abstained on every
  run (`DEADLINE_EXCEEDED` or `DETERMINISTIC_MISMATCH`); "10/10" here means 10/10 bounded HTTP/SSE
  responses, not 10/10 `RECOMMEND` verdicts — verdict rate is the separate, already-documented,
  unresolved gap above. A prior fake-provider figure cited in planning (p50 3,038.6ms / p95
  4,164.3ms / 10-of-10) does not reflect real provider tail latency; see the evidence JSON for the
  full caveat and source discrepancy note.
- Representative PDF/PPTX cold/warm smoke was recorded as measured values only
  (`.omo/evidence/task-27/pdf-pptx-cold-warm-smoke.json`); per plan scope this is not used to
  reach a cold/concurrent-capacity or long-run p95 conclusion.

### What is deferred to September hardening

- Cold/concurrent production capacity, soak testing, and any long-run p95 conclusion.
- OCR production hardening (accuracy, throughput, and cost — see below).
- The combined `CORE5_GREEN` / `OCR_GREEN` / `COACHING_WORD_TIMING_GREEN` / `STAGE_ZERO_CARDS`
  receipt that this document's completion language is gated on.

## OCR status and cost

OCR is tracked as its own status and cost line, separate from `CORE5_GREEN`; an OCR shortfall does
not change the core-5 latency/functional results above, and it is why overall completion remains
held open under `include-hardening`.

- **`OCR_GREEN = true`.** Current measurement (`.omo/evidence/task-26/ocr-resource-psm6.json`):
  the pinned Tesseract path restores the fixture sentinel exactly on all 10 pages
  (`exactSentinelPages: 10`). The earlier garbling (`형식 ron —| 근거 자료 2026`) was not an image
  quality problem — PSM 11 (sparse text) split the wide-letter-spaced Korean title across lines;
  switching to PSM 6 (uniform block) in `services/ingestion/ocr.py` resolved it. The PSM 11
  baseline is retained at `.omo/evidence/task-26/psm11-baseline-resource.json`
  (`exactSentinelPages: 0`). Vertical probe exits 0 with a single DB chunk, anchor
  `slide=1&chunk=1`, lexical match true, and live upload returns 201.
- No thermal or performance warning was recorded before or after the OCR run (`pmset`: "No thermal
  warning level has been recorded" / "No performance warning level has been recorded").
- Four OCR failure paths are confirmed mapped to `422 OCR_UNAVAILABLE`: missing Tesseract binary,
  missing pinned `kor` model, non-zero Tesseract exit, and empty TSV output. Encrypted PDFs are a
  separate, distinct rejection (`encrypted_document`), not counted among the four.
- Four OCR failure paths are confirmed mapped to `422 OCR_UNAVAILABLE` (unchanged): missing Tesseract binary, missing pinned
  `kor` model, non-zero Tesseract exit, and empty TSV output all return `422 OCR_UNAVAILABLE`;
  encrypted PDFs stay a separate, distinct rejection (`encrypted_document`).
- Cost: pinned Tesseract models total 5,790,503 bytes (`eng` 4,113,088 + `kor` 1,677,415); the
  PSM 6 run used 1.82s wall and 149,471,232 bytes max RSS versus the PSM 11 baseline's
  219,332,608 bytes; rasterizing a scanned page for OCR adds 17,805,650 bytes of image data per
  the measured fixture.


## Recommendation latency after slot hedging

The plan originally forbade any retry, queue, circuit breaker or budget scheduler outside the
existing five second recommendation deadline. That guardrail was relaxed by explicit decision for
the `rerank` and `llm` slots only: at most one duplicate call per slot, inside the same deadline
signal, against the same model, schema and trusted context. The 5,000ms budget, the 500ms terminal
guard, deterministic evidence reconciliation, verifier verdict handling, ACL, source revision and
idempotency are unchanged, and a primary that settles with an error never starts a new call.

Measured on the frozen text-layer fixture, 20 direct recommendations per stage:

| Stage | RECOMMEND | Deadline aborts | Wall p95 |
| --- | --- | --- | --- |
| Before hedging | 10/20 | 9 | 4,505ms |
| Hedge introduced | 15/20 | 5 | 4,505ms |
| Verifier tail reserved | 17/20 | 3 | 4,504ms |
| Duplicate starts at once when delay cannot avoid it | 19/20 | 1 | 4,301ms |

Core-5 acceptance was then run three times in a row and every round finished `exitCode 0` with
positive 2/2, negative 6/6 and stt 2/2. The same suite produced 2/12 positive across six rounds
before hedging.

### Ten-run cohorts

| Cohort | Success | p50 | p95 | Verdict |
| --- | --- | --- | --- | --- |
| Existing recommendation flow | 10/10 | 3,637ms | 4,497ms | meets the bar |
| Confirmed FINAL to Console | 8/10 | 3,360ms | 3,623ms | p95 meets the bar, 10/10 does not |

Both cohorts sit inside the 5,000ms p95 requirement. The two shortfalls in the FINAL to Console
cohort were `CONFLICTING_EVIDENCE` at 3,623ms and `DETERMINISTIC_MISMATCH` at 1,944ms, neither of
which came close to the 4,500ms abort, so neither is a latency failure and no amount of further
hedging moves them. That cohort derives its query from the whisper transcript, which differs run
to run, and on some transcripts the generation slot asserts a fact that is absent from the
evidence or the verifier reports a conflict. The evidence gate rejecting those claims is the
behaviour the gate exists for, and it was not weakened to raise the number.

Closing that remaining gap is a grounding-quality question rather than a latency one. The
full-catalogue model bakeoff found no configuration that combines grounded output with a response
time that fits the budget, the deck fixtures are frozen, and the evidence gate stays as it is.
It therefore stays open as September hardening, consistent with holding completion open here.


### Criterion 6 repeatability, measured over 100 runs

Five consecutive sets of the ten-run cohorts were measured at one commit and every set is recorded.

| Set | FINAL to Console | p95 | Existing flow | p95 |
| --- | --- | --- | --- | --- |
| 1 | 8/10 | 4,504ms | 6/10 | 4,509ms |
| 2 | 6/10 | 4,503ms | 8/10 | 4,504ms |
| 3 | 7/10 | 4,504ms | 8/10 | 4,504ms |
| 4 | 7/10 | 4,503ms | 0/10 | 4,507ms |
| 5 | 8/10 | 4,502ms | 7/10 | 4,505ms |

The p95 requirement holds without exception: the worst p95 across all one hundred runs was 4,509ms
against a 5,000ms bar. The ten-of-ten requirement was not reached in any set, in either cohort.

A standalone twenty-run profile at the same commit produced nineteen recommendations, so the
per-run rate is not fixed. Sustained batches are worse than isolated ones, and set four saw every
run in a cohort abort with a median already past the guard, which is a provider-wide slow window
rather than a code path. Hedging duplicates the generation call, so a long batch adds load to the
provider whose variance the hedge exists to absorb: it rescues an isolated slow call and cannot
rescue a uniformly slow window.

Everything available inside the guardrails has been applied. Hedging carried the standalone
profile from ten to nineteen recommendations out of twenty and deadline aborts from nine to one.
The full model catalogue was measured and no configuration combines grounded output with a
response that fits the budget. Stating the gate's grounding rule in the generation instruction was
tried, measured worse, and reverted. What remains is a product decision rather than an
implementation one, and completion stays open here accordingly.


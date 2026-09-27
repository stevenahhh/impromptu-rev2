# Task 3 baseline: ingestion / STT / coaching / recommendation

Scope: `.omo/plans/impromptu-ideal-experience.md` task 3 (GAP-6 baseline;
GAP-8/9/12/15 reproduction). Read-only. All probes hit the already-running
Compose project `impromptu-ulw-g003-demo` (private-backend on 127.0.0.1:3001).
No service restarts, no code edits, no secrets in evidence (login body redacted,
cookies/CSRF/passwords never written).

## Build provenance (important)

The stack was recreated by a concurrent worker mid-probe. Two baselines exist:

- **Pass A** (`live-probe.log`): private-backend image from 2026-09-27T15:21Z,
  i.e. BEFORE `5a7a11e` (decouple FINAL recommendation work) and `280c649`
  (report-read recovery seam). Verified by in-container sha256 of
  `audio-ingest.ts` (d75de50f… ≠ HEAD) and `report/http.ts` (de510669… ≠ HEAD);
  `spoken-question-stt.ts` already matched HEAD (per-invocation STT deadline,
  i.e. GAP-8 fix was already in).
- **Passes B/C** (`live-probe-head.log`, `live-probe-lane.log`): rebuilt image
  02ac5781… with all three files matching HEAD `e407007`.

`stack-state.txt` records docker ps + both hash sets.

## Commands run (exit codes)

| Command | Exit | Log |
|---|---|---|
| `bun test services/private-backend/test/audio-ingest-http.test.ts services/private-backend/test/qa-http.test.ts` | 0 (40 pass / 0 fail) | `tests-bun.log` |
| `uv run --project services/ingestion pytest services/ingestion/tests/test_adapters.py -k ocr` | 0 (3 passed) | `tests-py.log` |
| `env -i HOME=$HOME PATH=/usr/bin:/bin uv run … pytest test_adapters.py -k ocr` (Tesseract hidden) | 0 (3 passed — all three monkeypatch `extract_ocr_text`, so this -k selection cannot observe a missing binary) | `ocr-absent.log` |
| `env -i … PATH=/usr/bin:/bin uv run --project services/ingestion impromptu-ingestion ingest tests/fixtures/format-neutral-decks/korean-scanned.pdf --job-id task3_ocr_absent --output /tmp/task3/ocr-absent/ingestion.json` | 0 — degraded success | `ocr-absent-cli.log`, `ocr-absent-manifest.txt` |
| `docker exec impromptu-ulw-g003-demo-private-backend-1 bun /tmp/embed.mjs` (POST /v1/embeddings via embedding-tls) | 200, **768 dims**, model `embeddinggemma` | `embedding-dims.txt`, `embed.mjs` |
| `python3 /tmp/task3/probe.py` (pass A) | full trace | `live-probe.log`, `probe.py` |
| `python3 /tmp/task3/probe-head.py` (pass B) | full trace | `live-probe-head.log`, `probe-head.py` |
| `python3 /tmp/task3/probe-lane.py` (pass C) | full trace | `live-probe-lane.log`, `probe-lane.py` |
| `python3 /tmp/task3/followup.py` (report after provisioning, pass A) | full trace | `followup.log`, `followup.py` |
| in-container `psql` snapshots | — | `db-snapshot.txt` |

## Working vs unsupported (observed, live stack)

**Working**
- `POST /v1/deck-uploads`: text-layer PDF 201 (~1.1s); scanned PDF 201 (~42s)
  with per-slide `ocr_applied` warnings inside `ingestion.json` and the OCR
  sentinel restored on slide 1 — in-container artifact proof (`upload.http`).
  OCR text availability is NOT in the HTTP receipt (`extractedText:""`).
- Spoken-question STT `POST /v1/question-clips/transcription`: TRANSCRIBED
  `형식중립 근거 자료 2026` (ko, 2607ms) in ~9.1s on both builds — the pinned
  local whisper.cpp path works (pass A 5.6s in earlier G001 evidence too).
- Continuous capture STT: grant(201) → SSE READY → frames(202) → PARTIAL/FINAL
  transcript events with correct Korean text on both builds.
- Coaching persisted in report: `speech.timingAggregate.finalCount` = number of
  FINALs recorded live, `speakingDurationMs` = sum of FINAL word timing, plus
  `coachingAggregate{cueCount,latestCurrentWordsPerMinute,latestPrevious…}`
  in the finalized report and the DB (`db-snapshot.txt`, `report-final.json`).
- 768-dim `embeddinggemma` serving at `https://embedding-tls:8443` (in-container
  query above; `recommendation-stage …/embedding` INFERENCE 200s in backend log).
- QA pipeline end-to-end on ended sessions: open → ask → ABSTAINED recorded
  durably in `qa_exchanges` (ask_seq, origin, defense_payload).

**Unsupported / failure paths (typed, fail-closed)**
- `POST /v1/question-clips/transcription`: wrong Content-Type →
  `{"outcome":"REJECTED","reason":"UNSUPPORTED_CODEC"}`; empty body →
  `EMPTY_AUDIO`; corrupt webm → `TRANSCRIPTION_FAILED`; declared duration
  >120,000ms → `TOO_LONG` — all HTTP 200 typed rejections.
- `POST /v1/deck-uploads` garbage → 400 `deck_upload_rejected:malformed_input`.
- `GET /v1/audio/events` or `/v1/audio/frames` without `__Host-capture` → 401
  `capture_grant_required`; grant without consent → 400 `INVALID_REQUEST`;
  grant on ended/second device path → typed rejections (`GRANT_REPLAYED`,
  `GRANT_EXPIRED` observed on cleanup DELETEs).
- `POST /v1/recommendations` malformed body → 200 `ABSTAIN:INVALID_REQUEST`.
- Absent OCR executable: ingestion **degrades**, never fails — exit 0 with
  `ocr_unavailable` warnings and zero text per scanned slide. The HTTP
  422 `OCR_UNAVAILABLE` mapping (`deck-uploads.ts` via `error[ocr_unavailable]`
  stderr) is currently unreachable from "Tesseract missing" alone.

## Findings

- **F1 (GAP-15, reproduced live)**: on the pre-5a7a11e build, a ~5.4s held
  recommendation delayed the *next* segment's PARTIAL/FINAL (pass A ordering:
  FINAL-0 → REC-0 → PARTIAL-1). At HEAD the transcript stream proceeds
  concurrently (FINAL-1 lands while REC-0 is in flight) and RECs publish in
  arrival order — but ONLY while the stream is STARTED. `stream/stop` cancels
  in-flight recommendation jobs (`#cancelRecommendations`), so a capture that
  ends before providers return emits transcript-only SSE and TERMINAL COMPLETED
  (pass B). Consequence: the last utterance's recommendation is silently
  dropped on normal stop, not just on overload.
- **F2 (new failure path, both builds)**: `POST …/end` and `GET …/report` return
  bare HTTP 500 (`SessionReportAccessDeniedError`, unhandled) for any session
  that never produced a slide visit or QA exchange — provisioning inserts the
  `presentation_sessions` row only on *write* paths, while
  `endSession`/`readForOwner` `assertOwner` on *reads*. The lifecycle still
  flips to ENDED (verified via `POST …/qa-defense` → `status:"ENDED"`); the
  report recovers only after a QA ask provisions the row (then /end retry →
  202, GET /report → 200 incl. coaching). On pass A's build (no `resolveEnded`
  seam) a stuck PENDING would have stayed 202 forever; HEAD recovered on read.
- **F3 (reproduced 2x, unexplained)**: the audio SSE connection severs
  mid-capture with `IncompleteRead` ~8-9s after the last delivered event while
  a whisper inference is in flight (pass A t=35.8s, pass C t=52.6s). No
  TERMINAL; grant later reports GRANT_EXPIRED/GRANT_REPLAYED. Candidates: a
  server-side idle/read timeout on long streams, or abort on error inside the
  forwarding path. Left as a repro for task 22 (integration-e2e).
- **F4 (GAP-6 baseline, today's provider truth)**: every recommendation call in
  this session — `/v1/recommendations`, audio-dispatched lane, `/v1/qa-defense`
  — ended `ABSTAIN:DEADLINE_EXCEEDED` at latencyMs=5400 (5,000ms budget + 400ms
  terminal guard). Backend log shows per-stage embedding/rerank/llm INFERENCE
  successes at 1.8-3.3s plus `deck-index … INDEX 500 FAILED:PREPARATION_FAILED
  "Deck embedding failed: cancelled"` ~15s after each upload (15s index
  deadline in `bootstrap/retrieval-stack.ts:49` vs. contended ollama), so deck
  chunks were likely never embedded; RETRIEVAL then produced no internal
  candidates and the deterministic gate/verifier consumed the rest of the
  budget. Matches task-50's "rested vs saturated" provider sensitivity; do NOT
  cite a historical pass rate — today's rate was 0/N on this stack.
- **F5**: `-k ocr` pytest selection exercises only monkeypatched OCR seams; the
  real absent-Tesseract behavior had to be probed at CLI level (above).

## Historical receipts read (referenced by plan)

- `.omo/evidence/task-50/final-state.json`: criterion 6 NOT MET (9/10 cohorts,
  one DEADLINE_EXCEEDED each); 13/13 gates, 576 tests green.
- `.omo/evidence/task-53/receipts.json`: 10/10 cohorts @ p95 ~4.6s on that
  commit, "include-hardening" boundary. Conflicts with today's live 0/N —
  provider variance, exactly why the plan forbids citing it.

## Files

`tests-bun.log`, `tests-py.log`, `ocr-absent.log`, `ocr-absent-cli.log`,
`ocr-absent-manifest.txt`, `live-probe.log` (pass A), `live-probe-head.log`
(pass B), `live-probe-lane.log` (pass C), `followup.log`, `final-order.log`,
`upload.http`, `embedding-dims.txt`, `db-snapshot.txt`, `report-final.json`,
`stack-state.txt`, `cleanup.txt`, probe scripts `probe.py`, `probe-head.py`,
`probe-lane.py`, `followup.py`, `embed.mjs`.

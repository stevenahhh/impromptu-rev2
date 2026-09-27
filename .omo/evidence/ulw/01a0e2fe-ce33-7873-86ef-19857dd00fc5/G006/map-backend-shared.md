# G006 — Backend/shared diff → plan-task map

Scope: `packages/contracts/src/private-reference-documents.ts`, `services/private-backend/src/http/responses.ts`, `services/private-backend/src/reference-documents.ts`, `compose.production.yaml`. Plan: `.omo/plans/impromptu-ideal-experience.md` (41 tasks). Diff base: uncommitted working tree vs HEAD.

## File → intent → plan task

| File | Diff intent | Plan task(s) served |
|---|---|---|
| `packages/contracts/src/private-reference-documents.ts` | Adds `"EMBEDDING_UNAVAILABLE"` to `ReferenceDocumentRejectionReasonSchema` (line 23). | Task 17 (reference readiness truthful; GAP-12) and Task 30 (자료와 AI 준비 상태 분리, "실제 서비스 미설정 분기"). The enum is the transport for "AI/embeddings not ready" vs "file not usable". |
| `services/private-backend/src/http/responses.ts` | Maps `EMBEDDING_UNAVAILABLE` → HTTP 503 in `REFERENCE_REJECTION_STATUS` (line 27). | Same: 17 (503s retryable) / 30 (retry-per-cause). Companion to the contract enum. |
| `services/private-backend/src/reference-documents.ts` | (a) Adds `EMBEDDING_UNAVAILABLE` to the internal `ReferenceRejectionReason` union (line 214). (b) Replaces `throw` on bad/missing embedding with degrade-to-EMPTY: failed `embed()` empties `rows`, writes the doc row as `EMPTY`/`chunk_count=0`, still returns ACCEPTED (lines 366–385, 434–435). | Task 17 acceptance "mark such pages unsearchable until indexable evidence exists"; Task 30 "AI 불가 상태에서도 준비된 슬라이드 발표 가능". The union member is now dead — nothing produces it (see defects). |
| `compose.production.yaml` | Adds `STAGE_ORIGIN: ${STAGE_PUBLIC_ORIGIN:?}` to the `console` service environment (line 176). | Task 39 (배포 설정과 고객 진입점 일치; Files row names `compose.production.yaml`, `.env.example`, `stage-origin.ts`) and the E14 discrepancy row (plan line 1045: "브라우저에 들어가는 Stage origin은 빌드 시점 환경변수다"). Enables the runtime `window.__STAGE_ORIGIN` override in `apps/console/src/app/(console)/layout.tsx:19-24` + `apps/console/src/stage-origin.ts` (also modified, outside my scope) so rotating tunnel URLs don't need a rebuild. Also groundwork for task 32's audience-link flow (stageUrl consumer). Not part of task 29/30's stated file rows — 30's "대응 backend 오류 매핑" covers the reference-documents.ts change. |

## Contract-field trace (VERIFY requirement)

`EMBEDDING_UNAVAILABLE`:
- Producer: **none.** `acceptReferenceDocuments` never returns it; `boundedReferenceUploadForm` (request-bodies.ts:85-117) only returns `MALFORMED_INPUT`/`TOO_LARGE`. The union member in reference-documents.ts:214 and the schema enum in private-reference-documents.ts:23 are unreachable.
- Consumer: `referenceUploadRejection` → 503 (responses.ts:27,64-75). Console `referenceDocumentUploadView` passes any string `reason` through (reference-documents.ts:55-57) and the panel renders it verbatim: `text.referenceRejected.replace("{reason}", outcome.reason)` (reference-documents-panel.tsx:67). Locales contain no per-reason mapping (`referenceRejected` is a single template, en.json:43/ko.json:43).

`status`/`chunkCount` in `ReferenceDocumentSummary`:
- Producers: upload response (reference-documents.ts:450-456 — from `document.chunks`, i.e. extracted text) and list query (lines 468-495 — from the DB row, i.e. embedded `rows`).
- Consumers: `reference-documents-panel.tsx:133-135` (INDEXED → "{count} chunks indexed"; EMPTY → "No text extracted") and `apps/console/src/reference-documents.ts` parser.

These two producers now diverge (defect 2).

## Defects

| # | File:line | Defect | Reproduction |
|---|---|---|---|
| D1 | reference-documents.ts:399 (the `if (rows.length > 0)` guard around the DELETE at 402) | **Stale chunks survive a degrade re-upload.** Re-uploading a doc whose embedding now fails skips the DELETE of the old chunk rows while the DB row is rewritten to `EMPTY`/`0`. Old vectors remain retrievable → recommendations can still cite a document the panel reports as "No text extracted". Violates task-17 "mark unsearchable until indexable". | Upload `notes.md` with working embeddings (INDEXED, chunks written). Make `embed()` throw; re-upload same filename → row says EMPTY/0, but `private_app.deck_retrieval_chunks` rows for that `document_id` still exist. |
| D2 | reference-documents.ts:454-455 | **Upload response lies about status/chunkCount when embedding fails.** `status: document.chunks.length > 0 ? "INDEXED" : "EMPTY"` and `chunkCount: document.chunks.length` are computed from extracted text, not from `rows`. A degrade upload returns `INDEXED` + N chunks while persisting `EMPTY`/0; the same document flips state on the next list call. The panel briefly claims "N chunks indexed" for an unsearchable file — directly against task 17/30 intent. | `embed()` throws; upload `notes.md` (non-empty). Response: `status:"INDEXED", chunkCount:>0`. GET list: `status:"EMPTY", chunkCount:0`. |
| D3 | private-reference-documents.ts:23 + reference-documents.ts:214 + responses.ts:27 | **`EMBEDDING_UNAVAILABLE` is dead contract.** Schema accepts it, HTTP maps it to 503, but no code path emits it; the HTTP rejection-mapping test (reference-documents-http.test.ts:189-197) does not include it. Contract outruns its producer — speculatively valid reason string with no behavior. If a client ever receives it, the panel prints the raw enum into user text (task-17 violation: "raw server reason strings" must not render). | Code inspection; no `reason: "EMBEDDING_UNAVAILABLE"` anywhere in `services/` outside the type union and status map. |
| D4 | reference-documents.ts:370-385 | **Embedding outages are swallowed silently.** `catch { embeddable = false }` treats a transient provider failure the same as "unconfigured": no logging, no rejection reason distinguishes "text extracted but unsearchable" from "EMPTY_INPUT". Persisted `EMPTY` overloads "no text" with "no embeddings" — consumers (panel badge "No text extracted") show a misleading cause. Task 30 wants per-cause recovery; the contract cannot express it. | `embed()` rejects once; document is accepted EMPTY indistinguishable from a whitespace-only file. |
| D5 | compose.production.yaml:176 | **None found.** `STAGE_PUBLIC_ORIGIN` already required by `projection-gateway` (line 76) and the console build arg (166); `.env.example:29` defines it. Runtime env is consumed by `layout.tsx` → `window.__STAGE_ORIGIN` → `stage-origin.ts`. Consistent end-to-end. | — |

## What remains unimplemented for this scope

- **EMBEDDING_UNAVAILABLE wiring (or removal).** Either the library should return it (and the route+panel render an actionable retry message) for "provider configured but down", or the enum/503 mapping should be dropped. Currently a half-step: contract widened, producer degraded to silence instead.
- **Distinguishable "unsearchable" state (task 30).** Only `INDEXED`/`EMPTY` exist; "uploaded but AI/embeddings unavailable" cannot be expressed, so the panel's EMPTY copy ("No text extracted") is wrong for the degrade path.
- **D1/D2 fixes** as above (re-upload chunk cleanup; report status from `rows`).
- **Console-side reason translation (task 17/29).** Raw `reason` strings still render via `referenceRejected` (panel:67,78) — no locale mapping exists, so if EMBEDDING_UNAVAILABLE ever reaches the client the enum leaks into UI text.
- **Task-17 test coverage.** No test exercises the degrade path or the EMBEDDING_UNAVAILABLE 503 mapping (reference-documents-http.test.ts covers only the 7 original reasons; the library test at line 321 covers text-empty EMPTY, not embed-failure EMPTY).
- **Task 39 remainder.** Only the `console` service env was added; `docker compose config` verification, runbook, and `.env` drift detection from the task row are not in this diff.

## Verdict

`compose.production.yaml` cleanly serves task 39 (with task-32 groundwork) — no defect. The other three files together implement half of tasks 17/30's "degrade gracefully when embeddings are unavailable" intent: uploads no longer hard-fail and files are kept (good), but the implementation leaves stale retrievable chunks on re-upload (D1), reports a false INDEXED status in the upload response (D2), renders an overload of EMPTY with the wrong user-facing cause (D4), and adds an `EMBEDDING_UNAVAILABLE` rejection reason + 503 mapping that nothing produces (D3 — contract drift ahead of producers and consumers). Task 17's acceptance criteria ("mark unsearchable", "translate known backend errors", "reference list 503 shows retry") are only partially backed by these diffs; the reachable-state truthfulness and locale mapping still owe implementation.

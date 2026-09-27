# F4 repair: recommendation DEADLINE_EXCEEDED churn and the cancelled deck index

Scope: `services/private-backend/src/retrieval` + recommendation orchestration entry point
(`InternalRetrievalService.retrieve`, consumed by the verifier pipeline) + focused tests.
Worktree changes only; no git staging/commits. No new providers, no contract widening:
`RECOMMENDATION_BUDGET_MS` = 5,400ms and the ≤5,000ms acceptance bar are unchanged, the
deterministic evidence gate and ACL/RLS checks are untouched.

## Diagnosis (measured on `impromptu-ulw-g003-demo`)

Baseline F4: every `POST /v1/recommendations` ended `ABSTAIN:DEADLINE_EXCEEDED` at
latencyMs=5,400 and every upload produced `deck-index … INDEX 500
FAILED:PREPARATION_FAILED "Deck embedding failed: cancelled"` at ~15,027ms.

Measured mechanics:

- `InternalRetrievalService.retrieve` awaited `corpus.prepare()` **inside** each
  recommendation. `prepareDeckCorpus` held one advisory-locked transaction across the
  embedding of every missing chunk (up to 8 concurrent calls).
- Each index embed call is minted with `AbortSignal.timeout(15_000)` /
  `deadlineAtMs = now + 15_000` (`bootstrap/retrieval-stack.ts:49`). The ollama
  `embeddinggemma` endpoint behind `embedding-tls` effectively serializes requests:
  measured direct `/v1/embeddings` ≈750ms/call; a routed call ≈130ms idle but ≈2.5s
  each once the queue held the backend's own index bursts (in-container probes:
  `/tmp/router-probe.ts`, `/tmp/decompose.ts`; spawn alone ≈18ms, isolate round-trip
  ≈140ms — overhead was queueing, not isolation).
- Failure loop: an embed call queued past its 15s deadline fails `cancelled` →
  `Promise.all` rejects → the **whole advisory-locked transaction rolls back** →
  zero durable chunks → the next recommendation's inline `prepare` re-embeds the
  whole deck → N concurrent recommendations each queued 8-way bursts → every
  recommendation-stage call waited behind the flood and hit the terminal deadline.
  Every `deck-index` line in the baseline log is one of these doomed runs.
- Provider batching is not an escape: one batched `/v1/embeddings` request with 8
  inputs took 19.6s vs ~6s serial — slower per item on this ollama build.

## Fix

`src/retrieval/internal-retrieval.ts` — `#prepareInBackground`:

- `retrieve` now starts corpus preparation **once per deck scope**
  (`tenantId:deckVersion:manifestHash`), deduplicated by an in-flight map, and does
  not await it. Twenty concurrent recommendations share exactly one index run and
  each proceeds straight to the ACL prefilter/ANN gate. On a cold or partially built
  corpus retrieval returns no candidates → fast honest `INSUFFICIENT_EVIDENCE`;
  committed waves make the corpus converge and later calls retrieve normally.
  The map entry clears on settle, so a failed run is retried by the next retrieval
  rather than wedging; a rejected prepare no longer even reaches `retrieve`'s
  catch-all — the ACL re-check in `prefilter` keeps the fail-closed path identical.

`src/retrieval/deck-corpus-preparation.ts` — wave-wise commits under the lock:

- The single embed-everything transaction is now a loop of
  `EMBEDDING_WAVE_SIZE = 4`-row transactions. Each wave re-takes the advisory lock,
  deletes stale scope rows once (computed from the pre-scan read; skipped when none),
  re-reads committed `object_id`s **inside the lock**, embeds only the missing rows
  at `EMBEDDING_CONCURRENCY = 4`, commits successful inserts, then propagates the
  first embed failure **after** the commit. A cancelled run leaves finished waves
  durable and the next run embeds only what is still missing — verified by test.
- The "lock before embed" ordering (pinned by an existing test) is preserved per wave.
- Terminal outcomes preserved: `INDEXED:COMPLETED`,
  `SKIPPED:{ACCESS_DENIED,NO_MATCHING_MANIFEST,NO_EXTRACTABLE_TEXT,ALREADY_INDEXED}`,
  `FAILED:{ACCESS_CHECK_FAILED,ARTIFACT_ROOT_UNREADABLE,PREPARATION_FAILED}`.
- Concurrency lowered 8→4: the provider serializes anyway, and a shallower in-flight
  set keeps every call far inside its 15s deadline (4 × ~750ms ≈ 3s) while still
  overlapping the measured ~13.5s serial embed of a 44-chunk deck.

## Verification

Failing-first tests added, then implementation; all pass:

- `bun test services/private-backend/test/internal-retrieval.test.ts
  services/private-backend/test/postgres-deck-retrieval.test.ts` — **15 pass / 0 fail**
  (new: "retrieve resolves without waiting for a pending preparation",
  "concurrent retrievals share one in-flight preparation per deck scope",
  "a rejected preparation does not fail the retrieval that triggered it",
  "keeps committed waves after a mid-run embedding failure and resumes only the
  missing chunks").
- `bun test services/private-backend/test/` — **316 pass / 7 fail**, all 7
  pre-existing environment failures identical on HEAD (`qa-exchange-store-postgres`
  needs hostname `postgres`; `deck-upload-main` needs `/var/lib/impromptu` roots and
  ingest binaries on macOS).
- `bun run --cwd services/private-backend typecheck` — clean.
- `bunx biome check` on changed files — clean (one formatting fix applied).
- `bun run check:boundaries` — `{"service":"projection-gateway","architecture":"valid"}`.
- Repo-wide `bun run typecheck` fails at `scripts/verify-browser-runtime.ts:807`
  (TS2554) — a pre-existing error in a file modified by a concurrent worker;
  untouched by this task.

Live on-stack (files copied into the container, `docker restart` of
private-backend; image build was not needed since Bun executes TS directly):

- Upload `korean-text-layer.pdf` → first index run **`INDEXED:COMPLETED` in 5,881ms**
  (baseline: FAILED at 15,027ms after every upload); all later runs
  `SKIPPED:ALREADY_INDEXED` in 2–4ms. Zero `PREPARATION_FAILED`/`cancelled`
  deck-index lines since the fix (`deck-index-log.txt`).
- `live-verification.log`: attempt 1 `ABSTAIN INSUFFICIENT_EVIDENCE` 956ms (index
  still building — honest cold abstain inside budget), attempts 2–3
  `DETERMINISTIC_MISMATCH` (gate working as designed), attempt 4 **RECOMMEND
  latencyMs=3,323** citing `internal:bc928560…` anchor `slide=1&chunk=1`
  title "Slide 1" — the uploaded deck's own chunk, verified by
  `durable evidence: 6 rows × 768 dims, corpus_kind=DECK_SLIDE` in
  `index-rows.txt`.
- `recommendation-cohort.log` (same warm deck): **6/12 RECOMMEND at
  2,044–3,808ms, 6 honest `DETERMINISTIC_MISMATCH` abstains at 1,771–2,216ms,
  0 DEADLINE_EXCEEDED**, all latencies under the 5,000ms bar. Combined with the
  cold-start run: 7 RECOMMENDs, every one citing `slide=1&chunk=1` of the uploaded
  deck. Rate vs. baseline: 0/N → ≥50% RECOMMEND on identical query text; abstains
  are deterministic-gate verdicts, not timeouts.

## Rate / latency summary

| Metric | Baseline (task-3) | After fix |
|---|---|---|
| Deck index after upload | FAILED `PREPARATION_FAILED` ~15,027ms, 0 chunks durable | `INDEXED:COMPLETED` 5,881ms, 6×768-dim rows durable |
| Repeat index runs | Re-embeds whole deck per request | `SKIPPED:ALREADY_INDEXED` 2–4ms |
| `/v1/recommendations` | 0/N, all `DEADLINE_EXCEEDED` at 5,400ms | 6/12 RECOMMEND 2,044–3,808ms; abstains ≤2,216ms; 0 deadline failures |
| Recommendation evidence | none | `internal:` deck chunks (`slide=1&chunk=1`, rights APPROVED) |

Remaining honest variance: `DETERMINISTIC_MISMATCH` abstains are the verifier gate
narrowing claims against a small deck — inside budget, by design, and not fabricated
recommendations.

## Files changed

- `services/private-backend/src/retrieval/deck-corpus-preparation.ts`
- `services/private-backend/src/retrieval/internal-retrieval.ts`
- `services/private-backend/test/internal-retrieval.test.ts`
- `services/private-backend/test/postgres-deck-retrieval.test.ts`

## Files in this evidence directory

`live-verification.log`, `recommendation-cohort.log`, `deck-index-log.txt`,
`index-rows.txt`, this summary.

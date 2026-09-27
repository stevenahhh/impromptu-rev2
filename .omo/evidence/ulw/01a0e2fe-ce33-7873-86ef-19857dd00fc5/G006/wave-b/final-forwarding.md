# Wave B node: final-forwarding — plan task 10 / GAP-15

## What the defect was

`EventForwardingAudioSttPort.#forward` in `services/private-backend/src/audio-ingest.ts` awaited
`publishTranscript` -> `#acceptTranscript` after yielding each router item. `#acceptTranscript`
awaited `resolveContext` and then the full `recommendations.recommend` round trip before
returning, so the async generator could not pull the next router item until the previous FINAL's
recommendation settled. A held recommendation promise head-of-line blocked every transcript
behind it, and a provider rejection rejected `transcribe` and faulted the whole capture.

## Files changed

- `services/private-backend/src/audio-ingest.ts`
  - `#acceptTranscript` is synchronous: validate, `onFinal`, dedupe, publish TRANSCRIPT. The
    FINAL transcript is published immediately for every FINAL (previously only when a
    resolvable recommendation context existed — PARTIAL/REPLACE were already unconditional).
  - New per-`presentationSessionId` serial `RecommendationLane` (queue + running + promise
    chain, `MAX_RECOMMENDATION_LANE_DEPTH = 4`, ~20s of provider headroom at the 5,400ms per-run
    deadline). Dispatch order decides report order; outcomes publish in FINAL order.
  - Lane overflow publishes a typed `ABSTAIN` (`BUDGET_EXCEEDED`) via the pipeline's `abstain`
    helper instead of queueing without bound.
  - `resolveContext` is resolved at job run time (fresh deck/manifest, not a stale dispatch
    snapshot); its throws degrade to "no context" (skip), provider rejections degrade to typed
    `ABSTAIN` (`MODEL_FAILURE`) instead of faulting the stream.
  - Cancellation: `#cancelRecommendations(grantId)` marks queued+running jobs for that grant;
    invoked on SSE disconnect (`openEvents` cancel), `stopStream`, and every TERMINAL publish
    (covers revoke, expiry, logout, session end, stream end). Job results discard on
    `job.cancelled`; `#publish` is controller-scoped so a late result cannot attach to a new
    session/slide stream.
  - `startStream`'s terminal continuation awaits `#drainRecommendations` only when the stream
    ended naturally while still `STARTED` (no abort), so ordered outcomes publish before the
    TERMINAL event; abort paths publish TERMINAL without waiting.
- `services/private-backend/test/audio-ingest-http.test.ts`
  - New `ConsecutiveFinalRouter` + `createRecommendationSystem` helpers and three tests.

## Reproduction (red before fix)

`bun test services/private-backend/test/audio-ingest-http.test.ts` from repo root, before the
source change:

```
(fail) ... > forwards a consecutive FINAL transcript while a recommendation is still pending [1003.58ms]
  error: router did not emit both FINAL events   (held recommend blocked the router loop)
(fail) ... > bounds the recommendation lane and reports provider failure as a typed abstention [1005.03ms]
  error: timed out waiting for audio SSE event
(fail) ... > revoking the grant cancels queued and running recommendations without leaking results [1005.52ms]
  error: timed out waiting for audio SSE event
 3 pass / 4 fail when run from services/private-backend cwd (fixture path is repo-root-relative);
 4 pass / 3 fail from repo root — the 3 new tests fail, all pre-existing tests pass.
```

## Verification (green after fix)

```
$ bun run typecheck        # root: tsc --noEmit && ui + console + stage typecheck — clean
$ cd services/private-backend && bun run typecheck   # clean
$ bunx biome check src/audio-ingest.ts test/audio-ingest-http.test.ts
Checked 2 files in 8ms. No fixes applied.

$ bun test services/private-backend/test/audio-ingest-http.test.ts
 7 pass / 0 fail / 124 expect() calls

$ bun test services/private-backend/test/audio-ingest-http.test.ts \
    services/private-backend/test/audio-lifecycle.test.ts tests/security/audio-lifecycle.test.ts
 15 pass / 0 fail / 155 expect() calls / 3 files

$ bun test services/private-backend/test/
 297 pass / 7 fail — all 7 are environmental, unrelated to this change:
   4x qa-exchange-store-postgres.test.ts  DNSException ENOTFOUND postgres (needs Docker DB)
   3x deck-upload-main.test.ts            DECK_STAGING_ROOT /var/lib/impromptu/staging absent
```

Key observed order in the head-of-line test: TRANSCRIPT final-a, TRANSCRIPT final-b both arrive
while `recommend` is still held on a deferred promise; only then do RECOMMENDATION final-a and
final-b publish, in order, before TERMINAL.

## Assumptions recorded

- Lane depth 4 chosen as ~20s provider headroom; overflow emits typed `ABSTAIN`/`BUDGET_EXCEEDED`.
- `recommend` in production is `PrivateRecommendationPipeline.recommend`, which enforces the
  documented 5,000ms-class deadline internally (recommendation-outcome.ts, 5,400ms budget) —
  unchanged, so the bounded-deadline "Must have" is preserved.
- Grant stop aborts outstanding+new recommendation work (plan: "grant stop, session end and
  disconnect abort outstanding work"); FINAL transcripts still publish during stop drain.
- No git add/commit per task rules; edits left in the worktree.

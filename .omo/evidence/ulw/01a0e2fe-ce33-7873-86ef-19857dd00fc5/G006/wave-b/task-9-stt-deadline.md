# Task 9 / GAP-8 — spoken-question STT deadline regression test

## Finding

Commit 88bd72a already moved `Date.now()` / `deadlineAtMs` inside the per-request closure in
`services/private-backend/src/qa/spoken-question-stt.ts` (verified at HEAD: `const now = Date.now()`
sits inside the returned async function, comment explains the factory-scope bug). Existing tests in
`spoken-question-http.test.ts` covered route semantics and STT outcome mapping but NOT the deadline
regression. Added a regression test only — no product-code changes.

## Files changed

- `services/private-backend/test/spoken-question-http.test.ts` — added test
  "mints the deadline per call — a clip long after construction still transcribes". The fake router
  reproduces the real `CancellationScope` check (`now >= context.deadlineAtMs` -> yields a
  `deadline_exceeded` complete event). `Date.now` is stubbed so two successive calls land 120s and
  240s after `createSpokenQuestionStt` construction; both must TRANSCRIBE. Under the pre-88bd72a
  code the deadline is minted at factory scope, so the first call at +120s is already expired
  (`deadlineAtMs = boot + 60_000`) and the test fails as TRANSCRIPTION_FAILED. Deterministic — no
  sleeps, no real clock dependency; `Date.now` is restored in `finally`.

## Plan task closed

- Task 9 / GAP-8 (regression coverage for the already-landed 88bd72a fix).

## Verification (verbatim)

`bun run typecheck` (repo + packages/ui + apps/console + apps/stage `tsc --noEmit`):

```
$ tsc --noEmit && bun run --cwd packages/ui typecheck && bun run --cwd apps/console typecheck && bun run --cwd apps/stage typecheck
$ tsc --noEmit
$ tsc --noEmit
$ tsc --noEmit
```
(exit 0, no diagnostics)

`bun test services/private-backend/test/spoken-question-http.test.ts services/private-backend/test/stt-whisper-cpp.test.ts`:

```
(pass) spoken question clip transcription route > passes a bounded clip through and answers with the typed TRANSCRIBED outcome [0.33ms]
(pass) spoken question clip transcription route > refuses oversized clips as TOO_LARGE without touching STT [0.34ms]
(pass) spoken question clip transcription route > refuses an unprovable or excessive duration declaration as TOO_LONG [0.06ms]
(pass) spoken question clip transcription route > a non-WebM upload is UNSUPPORTED_CODEC and an empty one is EMPTY_AUDIO [0.04ms]
(pass) spoken question clip transcription route > without local STT the route answers a typed STT_UNAVAILABLE, never a dead end [0.02ms]
(pass) spoken question STT service > concatenates FINAL transcripts into one question text [0.25ms]
(pass) spoken question STT service > maps model-router failures to honest uppercase rejections [0.09ms]
(pass) spoken question STT service > mints the deadline per call — a clip long after construction still transcribes [0.10ms]
(pass) spoken question STT service > silence is never fabricated into text — it stays EMPTY_AUDIO [0.04ms]
(pass) pins the local adapter descriptor and fails closed on a non-pinned model [0.83ms]
(pass) trusted local isolate emits a PARTIAL before one FINAL with monotonic word timestamps [705.80ms]

 11 pass
 0 fail
 35 expect() calls
```

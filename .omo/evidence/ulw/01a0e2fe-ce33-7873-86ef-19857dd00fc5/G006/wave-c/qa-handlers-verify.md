# Task 16 (st_01a0e37f) — Q&A handler regression coverage: confirmed landed on main

- Task: confirm regression tests for the new post-talk Q&A handlers exist on main and pass;
  record verbatim; no code changes.
- Scope read: `apps/console` + `services/private-backend` tests only.
- Verdict: **Coverage exists for every new Q&A handler — no handler lacks a test.**
  Backend suites pass green (58/0). Console Q&A suites pass on HEAD; in THIS dirty
  checkout two global locale key-set parity asserts fail from unrelated in-flight
  locale edits (see verbatim output). Zero edits made.

## Handler → covering test map

### services/private-backend

| Handler / route | Source | Covering test(s) |
|---|---|---|
| `POST /v1/qa-defense` + `POST /v1/presentation-sessions/:id/qa-defense` (ask/open post-talk Q&A) | `src/http/routes/qa-defense.ts` (commit `32f1287`) | `test/qa-http.test.ts` (1135 lines — wire, ledger seam, registered-handler e2e, re-ask rule) |
| `POST` spoken question clip transcription route | `src/http/routes/spoken-question.ts` (commit `4f30916`) | `test/spoken-question-http.test.ts` (267 lines; +43 from `98f66f8` pinning per-request STT deadline) |
| QA citations wire↔ledger mapping | `src/qa/qa-citations.ts` | `test/qa-citations.test.ts` |
| Abstention/ANSWERED outcome classifier | `src/qa/qa-defense-outcomes.ts` | `test/qa-defense-outcomes.test.ts` |
| Exchange ledger | `src/qa/qa-exchange-ledger.ts` | `test/qa-exchange-ledger.test.ts` |
| Postgres exchange store | `src/report/qa-exchange-store.ts` | `test/qa-exchange-store-postgres.test.ts` (not run here — needs DB) |
| Report finalizer Q&A section | `src/report/session-report-finalizer.ts` | `test/session-report-finalizer.test.ts` |
| Bootstrap wiring | `src/bootstrap/qa-defense.ts` | exercised via `qa-http.test.ts` `createQaDefense` / registered-handler tests |

### apps/console

| Surface | Source | Covering test(s) |
|---|---|---|
| Q&A defense panel (typed ask, retry, citation kinds, abstention variants) | `src/qa-defense-panel.tsx` (commit `18d34c0`) | `src/qa-defense-panel.test.tsx` (563 lines, 7 tests) |
| Spoken question control (press-record, SPOKEN/TYPED origin, denial/failure/unmount honesty) | `src/spoken-question-control.tsx` (commit `a224015`) | `src/spoken-question.test.tsx` (507 lines, 6 tests) |
| Report Q&A section render | `src/report-qa-defense.tsx`, `src/qa-defense-report.ts` (commit `a91ddfa`) | `src/presentation-report.test.tsx`, `src/session-report-view.test.ts` |
| Report host route | `presentation-report-page.tsx` | `src/presentation-report-page.test.tsx` |

## Verification output (verbatim)

Backend (cwd `services/private-backend`):

    $ bun test test/qa-http.test.ts test/spoken-question-http.test.ts test/qa-citations.test.ts test/qa-defense-outcomes.test.ts test/qa-exchange-ledger.test.ts
    ...
    58 pass
    0 fail
    222 expect() calls
    Ran 58 tests across 5 files. [102.00ms]

Console (cwd `apps/console`, `NODE_ENV=test` to override ambient production):

    $ NODE_ENV=test bun test src/qa-defense-panel.test.tsx src/spoken-question.test.tsx src/presentation-report.test.tsx src/session-report-view.test.ts src/presentation-report-page.test.tsx
    ...
    (pass) Q&A defense panel > leads a finished presenter into Q&A from the report and never offers it mid-talk
    (pass) Q&A defense panel > submits one request per question and renders every citation kind as a visible source
    (pass) Q&A defense panel > a transient abstention keeps the draft and retries the same retained question
    (pass) Q&A defense panel > a terminal abstention says the materials cannot support the question and offers no retry
    (pass) Q&A defense panel > an ANSWERED card leads with the exact asked question
    (pass) Q&A defense panel > both abstention variants keep the asked question visible on the card
    (pass) Q&A defense panel > retry resubmits the retained question and the re-rendered card still shows it
    (pass) spoken questions in the Q&A defense panel > a pressed-and-stopped recording fills the question field and never auto-submits
    (pass) spoken questions in the Q&A defense panel > a spoken question records origin SPOKEN and a typed one still records TYPED
    (pass) spoken questions in the Q&A defense panel > microphone permission denial shows honest locale copy and typing keeps working
    (pass) spoken questions in the Q&A defense panel > transcription failure renders its own copy and inserts no fabricated text
    (pass) spoken questions in the Q&A defense panel > unmounting while recording stops every MediaStream track
    (pass) the report host resolves labels from the in-session deck
    (pass) the report host falls back to ko ordinals when no deck is in session
    (fail) ko and en locale key sets stay equal
    (fail) spoken questions in the Q&A defense panel > ko and en locale catalogs keep identical key sets
     26 pass
     2 fail
     137 expect() calls
    Ran 28 tests across 5 files.

## Failing-test attribution (dirty tree, not a Q&A gap)

Both failures are the same assertion — global en/ko locale **key-set** parity. Cause
verified: the checkout's unstaged edits to `apps/console/src/locales/{en,ko}.json` removed
`evidenceApproval` from `ko.json` while `en.json` still has it:

    $ grep -c evidenceApproval apps/console/src/locales/en.json apps/console/src/locales/ko.json
    apps/console/src/locales/en.json:1
    apps/console/src/locales/ko.json:0

On clean HEAD both files contain the key (1/1), and the sibling run at `695f7d8`
(`task-16-qa-handlers.md`, same dir) recorded 13/0 green for
`qa-defense-panel.test.tsx` + `spoken-question.test.tsx`. This is a defect in the
in-flight locale edits, outside this QA node's scope; no fix applied per read-only brief.

## Files changed

None — verification-only node.

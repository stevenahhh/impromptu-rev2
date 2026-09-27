# Wave C — qa-expiry-refresh (st_01a0e37d): 5-minute Q&A ask-window expiry + coalesced refetch

**Verdict: PASS** — typecheck clean, lint clean, 128 QA-adjacent tests green (0 fail) under `NODE_ENV=test`.

## Interpretation (assumptions the codebase could not settle for me)

- The brief's "clip" = a post-talk Q&A **submission** (the ask, typed or spoken-clip-sourced)
  and the ask window it lives in. There is no submission *list* entity in the tree (the
  task-8/14 teammate inbox is not landed in this checkout); the one mechanism the brief maps
  onto is the Q&A-defense window opened on the report surface. Implemented accordingly:
  `askableUntilMs` = `qaStartedAtMs + QA_ASK_WINDOW_MS` (300_000), derived — never stored —
  so restart/restore snapshots compute the identical deadline.
- "LIVE eligible clip automatically starts a coalesced refetch chain (a recheck clock tick)":
  a new `QaRecheckClock` on the Console holds **one** pending timer at the earliest known
  deadline; the tick performs exactly one read-only `GET .../qa-defense` recheck and re-arms
  only while the server still answers `LIVE`. `EXPIRED`, `EMPTY` (never opened) and `ENDED`
  (caller-synthesized terminal) observations are terminal — they disarm and never re-arm.
  Consecutive still-LIVE rechecks are bounded at 4 (`maxRechecks`), exhaustion → `onFailure`.
- "a clip that expires while the presenter waits cannot silently sit as 'asking'": an EXPIRED
  verdict aborts the in-flight submission (the `AbortSignal` is now actually forwarded —
  `console-client.ts` previously dropped it) and the panel leaves ASKING for terminal EXPIRED.
- Backend status union is `EMPTY | LIVE | EXPIRED`; `ENDED` exists in the clock's observed
  union for the terminal-no-refetch rule the brief names.

## Files changed

- `packages/contracts/src/private-qa-defense.ts` — `QA_ASK_WINDOW_MS`, `QaWindowStatusSchema`,
  closed `QaDefenseWindowSchema`, `QaAskResultSchema` (closed outcome + required
  `askableUntilMs`; strictness preserved under `.extend()`, verified in-bun).
- `services/private-backend/src/http/routes/qa-defense.ts` — `qaWindow()` status derivation;
  `qaWindow` stamped on open; new read-only GET recheck route (owner-checked via
  `resolveQaSession`, same auth boundary); ask route rejects `now >= askableUntilMs` with
  `409 {"error":"qa_expired"}` **before** model spend or ledger write; ask response parses
  through `QaAskResultSchema` (acceptance carries the typed expiry).
- `apps/console/src/qa-defense.ts` — closed `qaWindow`/`askableUntilMs` parsing (missing
  deadline = unreadable, never unbounded); `QaDefenseLifecycle.qaWindow`; `QaDefenseAnswer`
  variants carry `askableUntilMs`; `QaDefenseExpiredError`; `readQaDefenseWindow` GET.
- `apps/console/src/qa-recheck-clock.ts` — **new**: the coalesced refetch chain.
- `apps/console/src/qa-defense-panel.tsx` — `EXPIRED` phase (hides ask controls, shows honest
  expired copy, retains settled answer cards), `applyWindow` terminal ramp, recheck wiring,
  local pre-send deadline gate on the same injected clock.
- `apps/console/src/console-client.ts` — `readQaDefenseWindow` seam; **fixed dropped
  `AbortSignal`** on `submitQaDefenseQuestion` (required for abort-on-expiry).
- `apps/console/src/session-client.ts` — re-exports (`QaDefenseWindow`, `QaDefenseExpiredError`).
- `apps/console/src/locales/{en,ko}.json` — `qaWindowExpired`, `qaWindowRecheckFailed`; removed
  dead `evidenceApproval` key from `en.json` (pre-existing parity defect; ko already lacked it).
- Tests: `services/private-backend/test/qa-http.test.ts` (6 new "qa ask window expiry" cases,
  GET context + mutable clock seams), `apps/console/src/qa-defense-panel.test.tsx` (4 new
  expiry cases + fixture deadline updates), `apps/console/src/qa-recheck-clock.test.ts` (new,
  7 cases), `apps/console/src/spoken-question.test.tsx` (fixture deadlines/types).
- `apps/console/src/private-api-proxy.test.ts` — drive-by: `biome --write` pure indentation
  reformat; the file was committed at HEAD already failing `bun run lint` (42-line
  whitespace-only diff, verified `git show HEAD:` output fails identically).

## Plan task closed

- Wave-C **Plan 14** — "5-minute clip Q&A expiry: typed askableUntil/expiresAt on each
  accepted submission; LIVE eligible clip auto-starts a coalesced refetch chain (recheck
  clock tick) so an expiring clip cannot sit silently as 'asking'; only LIVE refetches —
  expired/empty/ended stay terminal."

## Failing-first evidence

`NODE_ENV=test bun test` before implementation: 13 fail / 1 error (module missing) across
the new assertions — including `an ask ... ends EXPIRED, never left as 'asking'`, all six
`qa ask window expiry` backend cases, and all `QaRecheckClock` cases.

## Verify output (verbatim)

`bun run typecheck`:

```
$ tsc --noEmit && bun run --cwd packages/ui typecheck && bun run --cwd apps/console typecheck && bun run --cwd apps/stage typecheck
$ tsc --noEmit
$ tsc --noEmit
$ tsc --noEmit
TYPECHECK_EXIT=0
```

`bun run lint`:

```
$ biome check .
Checked 508 files in 76ms. No fixes applied.
LINT_EXIT=0
```

`NODE_ENV=test bun test` (14 QA-adjacent suites):

```
 128 pass
 0 fail
 573 expect() calls
Ran 128 tests across 14 files. [560.00ms]
TEST_EXIT=0
```

Named proofs the brief demanded (all `(pass)` in the run above):

- about-to-expire LIVE refetches: `an ask interrupted by its window's deadline refetches and
  ends EXPIRED, never left as 'asking'` + `a LIVE recheck verdict re-arms the chain...`;
  `the recheck read reports LIVE before the deadline and EXPIRED at it` (backend).
- expired stays terminal: `a window already EXPIRED at open stays terminal — no ask controls,
  no armed recheck`; `an ask at or past the deadline answers exactly 409 qa_expired without
  model spend or a ledger row`; `only LIVE refetches: EMPTY and ENDED ... never schedule`.
- coalescing/bounds: `observations coalesce`, `a recheck chain that never goes terminal is
  bounded and reports failure`, `dispose cancels the pending timer`.

## Notes

- Ambient `NODE_ENV=production` (`.env`) breaks `React.act`; QA suites were run with
  `NODE_ENV=test` per the established suite convention (`task-16-qa-handlers.md`, `.env:144`).
- Pre-existing defect fixed in passing: `ko.json`↔`en.json` parity (`evidenceApproval`) —
  was already red at baseline before my edits.
- No commits made; edits left in the worktree for the orchestrator's per-package commit.

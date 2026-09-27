# Task 18 — F2 fix: zero-activity end/report no longer 500s

Finding F2 from `G006/task-3/baseline-summary.md`: `POST /v1/presentation-sessions/:id/end` and
`GET /v1/presentation-sessions/:id/report` returned bare HTTP 500 (`SessionReportAccessDeniedError`,
unhandled) for any session that never produced a slide visit or Q&A exchange. Lifecycle still
flipped to ENDED, leaving the owner without a durable final report.

## Root cause

`private_app.presentation_sessions` rows were inserted only inside
`createProvisionedSessionReportRepository`'s write paths (`appendSlideVisit`, `appendQaExchange`,
`compareAndSetState`). Every store method — including the reads `readForOwner`, `readSlideVisits`,
`readQaExchanges` — opens its transaction with `assertOwner`
(`src/report/session-report-table-codecs.ts`), which throws `SessionReportAccessDeniedError` when
no `(tenant_id, session_id, owner_subject)` row exists. A zero-activity session's first repo access
is `SessionReportFinalizer.endSession` → `readForOwner`, so the owner was denied at the storage
boundary and the handler's catch-all emitted `internal_error` (500). This is a pure
row-provisioning invariant bug — not an authorization decision — so the fix belongs in the
provisioning adapter, not in the owner check.

## Fix

`services/private-backend/src/report/provisioned-session-report-repository.ts`:
`ensureOwningRows(principal, 1)` now runs before `readForOwner`, `readSlideVisits`, and
`readQaExchanges`, not just the three write methods. Owning rows exist before ANY repository
access. `ON CONFLICT DO NOTHING` never rewrites an existing row, so a session row owned by another
subject still fails `assertOwner` on the next statement — cross-tenant/non-owner denial preserved.
Epoch 1 matches the existing `appendQaExchange`/`compareAndSetState` provisioning precedent.
No migrations, no schema change, no route or lifecycle changes.

## Failing-then-passing deterministic tests

New shared harness `services/private-backend/test/support/provisioning-harness.ts`: a fake `Sql`
that records the provisioning INSERTs (with real `ON CONFLICT DO NOTHING` semantics) plus
`OwnershipCheckedReportRepository`, an in-memory repo that reproduces `assertOwner`'s verdicts.

`services/private-backend/test/provisioned-session-report-repository.test.ts` (+3 tests):
- `ends a zero-activity session into a real finalized report` — **pre-fix: FAIL**
  (`SessionReportAccessDeniedError` at `endSession` → `readForOwner`,
  provisioned-session-report-repository.ts:146); post-fix: FINALIZED report, durable re-read equal.
- `provisions the tenant and session rows before an owner read` — **pre-fix: FAIL**; post-fix
  asserts the tenant/session row contents.
- `keeps denying a subject that does not own the session row` — passes both ways; proves
  provisioning does not launder ownership (conflicting `owner_subject` row survives ON CONFLICT,
  `assertOwner` still throws).

`services/private-backend/test/session-http.test.ts` (+1 test, `wiredEndFlow` takes an optional
repository): `zero-activity end and report stay owner-successful through the provisioning adapter`
drives sign-in → `POST /v1/presentation-sessions` → `POST …/end` → `GET …/report` through the real
`createPrivateBackendHandler`, coordinator, `createSessionReportRead`, `SessionReportFinalizer`
and the real provisioning adapter over the fake Sql. **Pre-fix: HTTP 500** (`Expected: 202,
Received: 500`); post-fix: 202, lifecycle ENDED, GET → 200 finalized v2 report (empty
`slideVisits`, empty `qaDefense.exchanges`), second GET returns the identical body.

## Verification output

- `bun test` pre-fix (repro):
  `provisioned-session-report-repository.test.ts`: 4 pass / 2 fail — both failures
  `SessionReportAccessDeniedError` ("presentation session is not owned by this subject").
  `session-http.test.ts`: 12 pass / 1 fail — `expect(received: 500).toBe(202)` on `/end`.
- `bun test` post-fix, same files: **19 pass / 0 fail** (86 expects).
- `bun run --cwd services/private-backend typecheck` — clean.
- Focused suites:
  `bun test …/provisioned-session-report-repository …/session-report-finalizer
  …/session-http …/qa-http …/qa-exchange-ledger …/qa-exchange-store-postgres
  …/qa-defense-outcomes …/http.test.ts` — 83 pass; the 4 `qa-exchange-store-postgres` tests
  failed only with `ENOTFOUND postgres` (they need a real DB; the worktree `.env` points
  `PRIVATE_DATABASE_URL` at the compose hostname).
- Re-run with a real DB:
  `PRIVATE_DATABASE_URL=postgresql://private_app@127.0.0.1:32771/impromptu_private bun test
  services/private-backend/test/qa-exchange-store-postgres.test.ts` → **4 pass / 0 fail**
  against migrated Postgres (`impromptu-t1-pg` container): post-finalization exchange append,
  duplicate dedupe + typed conflict, insertion-order reads, same-tenant non-owner denial. Test
  rows deleted afterwards (4 session rows cascade, 1 tenant row).
- `PRIVATE_DATABASE_URL=…:32771/… bun test services/private-backend/test` — 320 pass / 3 fail;
  the 3 `deck-upload-main.test.ts` failures are pre-existing environment issues (spawned
  `main.ts` auto-loads the gitignored repo `.env`, so `DECK_STAGING_ROOT` resolves when the test
  expects it missing); unrelated to report code.
- Root `bun run typecheck` fails in `scripts/verify-browser-runtime.ts(807,32)` — another
  worker's uncommitted file; absent on stash/restore of my diff.
- `bunx biome check` on the 4 touched files — clean.
- `bun run test:db` not run: no migration/schema change (one existing adapter method reused);
  real-Postgres coverage obtained via `qa-exchange-store-postgres.test.ts` above.

## Live stack (impromptu-ulw-g003-demo)

`live-repro-prefixed.log` — running stack (pre-fix image), 127.0.0.1:3001, fresh zero-activity
session `ps_87115f5a…` via `POST /v1/presentation-sessions`:
`POST /end → 500 {"error":"internal_error"}`, `GET /report → 500`.

`live-verify-fixed.log` — same real stack's Postgres (`postgres` on
`impromptu-ulw-g003-demo_database`), same demo account, fixed worktree sources run in a throwaway
`impromptu/private-backend:latest` container (`docker create` + `network connect`, published
127.0.0.1:3199, `PRIVATE_PREPARED_EVIDENCE_STATE_KEY=task18-probe`). Shared stack untouched, no
restarts. Fresh zero-activity session `ps_9e7ed1e2…`:
`POST /end → 202 {"status":"accepted"}` in 9ms, `GET /report → 200` with a real finalized report
(reportVersion 2, `finalizedAtMs: 1790536547418`, empty `slideVisits`/`qaDefense.exchanges`,
derived zero-utterance speech summary — real persisted state, not a dummy body), re-read → 200
identical. DB receipt (`/tmp/task18/db-rows.txt` at capture time):
`presentation_sessions` row owner_subject=account_production, epoch 1;
`session_report_state` revision 2, `finalized_at` set, `report_version=2`. The pre-fix probe
session `ps_87115f5a…` has no `presentation_sessions` row — the bug, in the table itself.

## Cleanup

Throwaway backend container removed (`docker rm -f task18-fixed-backend`), probe session row +
cascade deleted (`DELETE 1`), `prepared_evidence_state` `task18-probe` row deleted, env files with
secrets removed from /tmp/task18, port 3199 closed. Demo stack untouched; the pre-fix ENDED
session remains (created by the already-running broken code on its own persisted state —
same footprint as every earlier probe).

## Files changed

- `services/private-backend/src/report/provisioned-session-report-repository.ts` — provision on
  reads; doc updated.
- `services/private-backend/test/support/provisioning-harness.ts` — new fake Sql + ownership
  harness.
- `services/private-backend/test/provisioned-session-report-repository.test.ts` — +3 tests.
- `services/private-backend/test/session-http.test.ts` — optional repository param on
  `wiredEndFlow`; +1 zero-activity end/report test.

Artifacts: `live-repro-prefixed.log`, `live-verify-fixed.log`, `zero-activity-report.md`,
probe at `/tmp/task18/probe.py` (not copied; regenerable from this doc + task-3 probe.py).

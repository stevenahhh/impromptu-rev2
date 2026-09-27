# pending-report (plan task 11 / GAP-14) — bounded report

## Plan task closed
- Plan row 11: "Recover a finalized report automatically after PENDING" (GAP-14: a report
  PENDING is read once and can stick).

## Mechanism found
- `GET /v1/presentation-sessions/:id/report` returned 202 pending whenever the persisted
  report row was missing or `finalizedAtMs` was null, and nothing ever retried
  `SessionReportFinalizer.endSession` after a failed/interrupted async finalization lane.
- The owner-scoped controller SSE channel rejects non-ACTIVE presentations
  (`PreparedEvidenceCoordinator.#authorizedPresentation`), so a report left PENDING after
  the talk ends cannot subscribe to REPORT_READY on reload — the event channel is
  unavailable exactly when it is needed. (Verified by inspection: no server-side emitter
  produces `REPORT_READY`; `rg "REPORT_READY" services/` matches nothing.)
- The Console report page read once and rendered a static pending caption forever.

## Changes
### Product
- `services/private-backend/src/report/http.ts`
  - `SessionReportEndContextResolver` gains optional `resolveEnded`, a recovery seam that
    returns the end context only while the presentation is genuinely ended.
  - `createSessionReportRouteHandler`: a GET that finds an ended-but-unfinalized report
    re-drives `reports.endSession` exactly once, awaits the joined `#ends` lane (dedup /
    CAS convergence), then re-reads persisted truth: 200 with the report, or 202 if the
    attempt is still outstanding/failed. No second end mutation on finalized reports.
- `services/private-backend/src/bootstrap/session-reports.ts`
  - Supplies `resolveEnded`: returns null for missing or ACTIVE presentations (a live
    talk's report can never be finalized by a read), and derives `endedOffsetMs` from the
    recorded `endedAtMs` so late recovery keeps the real talk duration.
- `apps/console/src/report-page.tsx`
  - The report read is shared between the mount effect and one explicit retry control
    (`data-report-retry`, quiet `Button`) rendered only while status is PENDING. One click
    re-issues exactly one read; a still-pending read stays pending, a failure keeps the
    existing FORBIDDEN path. No polling loop, no fixed sleep, no permanent spinner.
- `apps/console/src/locales/en.json`, `apps/console/src/locales/ko.json`
  - New `reportRetry` key ("Try again" / "다시 시도"), consistent with `qaRetry` /
    `audienceRetry` wording.

### Tests
- `services/private-backend/test/session-report-finalizer.test.ts` — new describe block
  "pending report recovery through the read route" (5 tests):
  1. ended + persisted pending row -> one read re-drives finalization -> 200 + report;
     second read is plain finalized (revision unchanged, no second end mutation).
  2. end whose async finalization lane FAILED -> read recovers to 200 (revision 2).
  3. read meeting an in-flight finalization joins it (exactly 2 CAS calls: pending row +
     finalizing), 200.
  4. live session -> stays 202 pending, `endSession` never driven (state stays null).
  5. route without `resolveEnded` keeps answering 202 (pre-change behavior pinned —
     equivalent to the red baseline: the same assertions would have failed against the
     old handler, which returned the first 202 read unconditionally).
- `apps/console/src/presentation-report-page.test.tsx` — 3 new tests:
  - PENDING -> explicit retry -> FINALIZED report renders without reload
    (read-sequencing client, no sleeps).
  - PENDING -> retry -> still PENDING keeps the retry control; third read lands the report.
  - Rejected read stays FORBIDDEN with no retry control and no report content.
  - `reportClient` refactored onto a `readSequencingClient` helper; `renderReportPage`
    accepts a client or a report (call-site compatible).

## Verification (verbatim outputs)

```
$ NODE_ENV=test bun test services/private-backend/test/session-report-finalizer.test.ts
...
 11 pass
 0 fail
 63 expect() calls

$ NODE_ENV=test bun test apps/console/src/presentation-report-page.test.tsx
...
 5 pass
 0 fail
 14 expect() calls

$ NODE_ENV=test bun test services/private-backend/test/session-http.test.ts services/private-backend/test/qa-http.test.ts
...
 39 pass
 0 fail
 170 expect() calls

$ NODE_ENV=test bun test apps/console/src/session-client.test.ts
...
 21 pass
 0 fail
 127 expect() calls

$ NODE_ENV=test bun test apps/console/src/App.test.tsx
...
 44 pass
 0 fail
 211 expect() calls

$ NODE_ENV=test bun test apps/console/src/presentation-report.test.tsx apps/console/src/session-report-view.test.ts apps/console/src/qa-defense-panel.test.tsx apps/console/src/presenter-console.test.tsx apps/console/src/playback-panel.test.tsx apps/console/src/locale-parity.test.ts
...
 31 pass
 0 fail
 1109 expect() calls

$ bun run typecheck
$ tsc --noEmit && bun run --cwd packages/ui typecheck && bun run --cwd apps/console typecheck && bun run --cwd apps/stage typecheck
$ tsc --noEmit
$ tsc --noEmit
$ tsc --noEmit
(exit 0)

$ bunx biome check <my 7 changed files>
Checked 7 files ... No fixes applied. (exit 0)
```

## Not caused by this change (pre-existing / concurrent-session state)
- `services/private-backend/test/qa-exchange-store-postgres.test.ts`: 4 fails,
  `DNSException: getaddrinfo ENOTFOUND postgres` — requires the isolated Docker database;
  unavailable in this environment.
- `services/private-backend/test/audio-ingest-http.test.ts`: 2 fails ("forwards a
  consecutive FINAL transcript while a recommendation is still pending", "bounds the
  recommendation lane ...") — these files are dirty under the concurrent task-10
  (final-forwarding) session; untouched here.
- `bun run lint`: 4 format errors, all in files owned by concurrent sessions
  (`apps/console/src/App.test.tsx`, `apps/console/src/private-api-proxy.test.ts`,
  `services/private-backend/src/audio-ingest.ts`,
  `services/private-backend/test/audio-ingest-http.test.ts`). None of my files appear in
  the lint output.

## Files changed
- services/private-backend/src/report/http.ts
- services/private-backend/src/bootstrap/session-reports.ts
- apps/console/src/report-page.tsx
- apps/console/src/locales/en.json
- apps/console/src/locales/ko.json
- services/private-backend/test/session-report-finalizer.test.ts
- apps/console/src/presentation-report-page.test.tsx

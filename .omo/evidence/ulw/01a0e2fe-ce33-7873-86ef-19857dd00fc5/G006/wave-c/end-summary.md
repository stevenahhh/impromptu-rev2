# Task wc-end-summary — honest end-presentation summary (st_01a0e37c)

- Task brief named "plan task 12 / GAP-4", but plan task 12 is the two-device invitation task
  and GAP-4 is Stage receipt narrowing; neither is this deliverable. The actual mechanism
  (`endPresentationAndAwaitReport` -> cockpit status -> report page) is covered by plan §4.8
  (발표 종료, 질의응답, 결과 — bounded PENDING path, honest metrics) and IS-7 (truthful bounded
  recovery). I report the closing under that mapping; the orchestrator can relabel.

## What I found (before edits)

The honest end-presentation flow already existed in `apps/console/src/playback-panel.tsx`:
`endPresentation()` shows `reportFinalizing` while in flight, `session-report-stream.ts`
subscribes to the owner-scoped controller-event stream BEFORE the end POST, awaits a
session-id-matched REPORT_READY parsed by the closed `sessionReport` view, and on a lapsed
signal discriminates via `readFinalizedReport` (FINALIZED -> navigate with artifact, PENDING ->
navigate without one, unreadable -> stay with `reportFinalizeFailed`). `report-page.tsx`
re-validates router state through the closed parser and the same session id, so a forged or
mismatched state can never render as the report.

What was missing/broken in the checkout:
1. No test pinned the honesty contract (in-flight shows no report; failure never shows a
   report that was not generated; PENDING is not presented as a finished report).
2. `reportFinalizeFailed` copy named the failure but not the bounded recovery (retry via the
   re-enabled end action), unlike sibling copy (`bindingExpired`).
3. Stale assertion sweep left the console suite red: `청중`→`발표 화면` / `코칭 지표`→`발표 도움말`
   / `비공개 발표 제어`→`Impromptu에 로그인` / retired `/live-publication` tests, plus a hardcoded
   `localhost:4174` stage origin that the ambient `NEXT_PUBLIC_STAGE_ORIGIN` (tunnel) defeats.
4. `en.json` kept a dead `evidenceApproval` key that `ko.json` no longer had — broke the
   `Messages` type (console tsc error) and every ko/en parity test.
5. `cockpit-audio-capture.test.tsx` restored `globalThis.fetch` AFTER
   `GlobalRegistrator.unregister()` in FIFO `afterAll`, resurrecting happy-dom's closed-window
   fetch and making `private-api-proxy.test.ts` fail in the same-run suite (verified by
   `bun test src/cockpit-audio-capture.test.tsx src/private-api-proxy.test.ts` -> fail; other
   order -> pass). Removed the manual restore; `unregister()` restores the real fetch itself.
6. `private-api-proxy.test.ts` had a pre-existing biome format error (unrelated to content).

## Changes

Product/copy:
- `apps/console/src/locales/ko.json` — `reportFinalizeFailed` now names the bounded recovery:
  "발표 결과를 정리하지 못했습니다. 발표는 아직 진행 중이니 '발표 종료'를 다시 눌러 주세요."
- `apps/console/src/locales/en.json` — same sentence shape; also removed dead `evidenceApproval`
  key (unused by any component; restores `Messages`/`ko` parity).

Tests (behavioral):
- `apps/console/src/playback-panel.test.tsx` — new suite-level tests:
  "the end summary opens with the report in flight and lands on the generated report"
  (deferred `endPresentationAndAwaitReport`: in-flight copy + zero report DOM, then the exact
  generated artifact renders on resolve, and the fallback read must not run mid-flight);
  "a failed end stays on the talk with bounded recovery copy, never a fabricated report"
  (PROBLEM status names retry, 발표 종료 re-enabled, no report card, talk stays live) —
  this one was written first and went RED on the missing recovery clause, then GREEN after the
  copy change; "a still-finalizing report lands on its page as pending, not as a report that
  was never made" (PENDING page, no report DOM). Plus two stale-copy assertion updates.
- `apps/console/src/presentation-report-page.test.tsx` — new: "a pending report shows
  finalizing copy, never a report that was not generated" (no report fields in DOM) and
  "a forged navigation state for another session is never shown as this report" (mismatched
  `presentationSessionId` state is discarded; page reads fresh and lands PENDING).
- `apps/console/src/App.test.tsx` — stale-copy sweep (청중→발표 화면 literals, 이 화면 연결,
  발표 준비 heading, Presentation preparation heading, 업로드한 자료/이용 조건 확인 필요 badges,
  브라우저가 발표 화면 창을 막았습니다, 관련 자료 report section); `stageOrigin` now uses the
  exported `STAGE_ORIGIN` instead of a hardcoded localhost; the private-nav landmark test moved
  to `/reports/:id` (nav only renders off-workspace) with a stub client; the two retired
  `/live-publication` tests now pin the retirement contract (no snapshot read, no approval
  affordance, session id never sent) instead of timing out on a removed page.
- `apps/console/src/presenter-console.test.tsx`, `apps/console/src/cockpit-rail.test.tsx`,
  `apps/console/src/evidence-card.test.tsx` — stale-copy assertion updates to current catalog.
- `apps/console/src/cockpit-audio-capture.test.tsx` — removed the afterAll fetch restore that
  poisoned later suites (cause documented inline).
- `apps/console/src/private-api-proxy.test.ts` — biome format only, no semantic change.

No edits to `session-report-stream.ts`, `playback-panel.tsx`, `report-page.tsx`, or any
closed-DTO/authorization/idempotency path — the mechanism was already correct and every change
above is copy or test.

## Verify output (verbatim)

`bun run typecheck` (repo root):

    $ tsc --noEmit && bun run --cwd packages/ui typecheck && bun run --cwd apps/console typecheck && bun run --cwd apps/stage typecheck
    $ tsc --noEmit
    $ tsc --noEmit
    $ tsc --noEmit
    (exit 0)

`NODE_ENV=test bun test src/presentation-report.test.tsx src/presentation-report-page.test.tsx src/session-report-view.test.ts src/session-client.test.ts src/playback-panel.test.tsx src/presenter-console.test.tsx src/cockpit-rail.test.tsx src/locale-parity.test.ts src/evidence-card.test.tsx src/App.test.tsx` (cwd apps/console):

    src/playback-panel.test.tsx:
    (pass) renders a routine slide change in the neutral state, never the problem state
    (pass) renders a dead-binding expiry in the problem state and keeps the anti-stranding path
    (pass) renders a slide failure in the problem state with its own announced region
    (pass) the end summary opens with the report in flight and lands on the generated report
    (pass) a failed end stays on the talk with bounded recovery copy, never a fabricated report
    (pass) a still-finalizing report lands on its page as pending, not as a report that was never made

    src/presentation-report-page.test.tsx:
    (pass) the report host resolves labels from the in-session deck
    (pass) the report host falls back to ko ordinals when no deck is in session
    (pass) a pending report shows finalizing copy, never a report that was not generated
    (pass) a forged navigation state for another session is never shown as this report

    103 pass
    0 fail
    511 expect() calls
    Ran 103 tests across 10 files.

Full console sweep `NODE_ENV=test bun test src`:

    193 pass
    0 fail
    889 expect() calls
    Ran 193 tests across 26 files.

`bun run lint` (repo root): `Checked 506 files in 70ms. No fixes applied.` — clean.

RED proof (before the copy change, same command):

    (fail) a failed end stays on the talk with bounded recovery copy, never a fabricated report
    error: expect(received).toContain(expected)
    Expected to contain: "발표 종료"
    Received: "발표 결과를 정리하지 못했습니다."

## Assumptions / notes

- "Bounded-recovery copy" = failure line that names the single recovery action while the live
  presentation stays retryable; implemented as copy on the existing PROBLEM status line.
- Retired-route tests were repurposed, not deleted: they now pin that `/live-publication`
  performs no candidate read/approval and leaks no session id.
- The ambient `NODE_ENV=production` still poisons React.act for an unprefixed `bun test`;
  all commands above run under `NODE_ENV=test` as the audit matrix prescribes.
- PENDING auto-recovery (event/poll on the report page) is plan task 11's sibling work
  (`st_01a0e36b`); this task only pins that PENDING is never shown as a finished report.

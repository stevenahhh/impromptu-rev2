# G006 — Dirty-tree test matrix (run-only)

Runner: `bun test --timeout 30000 <file>` from repo root, bun 1.4.2.
Two executions per file because the ambient env is hostile: the shell exports
`NODE_ENV=production` and repo `.env` injects `CONSOLE_PRIVATE_API_ORIGIN=http://private-backend:3001`
(Bun auto-loads `.env`; `env -u` does not clear it).

- Column **ambient** = `bun test <file>` as-is.
- Column **NODE_ENV=test** = `env NODE_ENV=test bun test <file>`.
- private-api-proxy also run once as `env NODE_ENV=test CONSOLE_PRIVATE_API_ORIGIN=http://127.0.0.1:3001 bun test <file>` (that row in parens).

## Matrix

| File | ambient exit | ambient pass/fail | NODE_ENV=test exit | test pass/fail |
|---|---|---|---|---|
| App.test.tsx | 1 | 0/44 | 1 | 21/23 |
| deck-upload.test.tsx | 1 | 0/6 | 0 | 6/0 |
| private-api-proxy.test.ts | 1 | 1/2 | 1 | 1/2 (3/0 with origin forced) |
| session-client.test.ts | 0 | 21/0 | 0 | 21/0 |
| cockpit-audio-capture.test.tsx | 1 | 0/5 | 0 | 5/0 |
| cockpit-rail.test.tsx | 1 | 0/5 | 1 | 3/2 |
| debug-toggle-placement.test.tsx | 1 | 0/3 | 0 | 3/0 |
| evidence-card.test.tsx | 1 | 0/4 | 0 | 4/0 |
| locale-parity.test.ts | 0 | 1/0 | 0 | 1/0 |
| playback-panel.test.tsx | 1 | 0/3 | 1 | 2/1 |
| presentation-report-page.test.tsx | 1 | 0/2 | 0 | 2/0 |

## First-failure excerpts (NODE_ENV=test runs)

**App.test.tsx** (23 fails) — `reload GET reproduces identical A-B-A report DOM`:
```
App.test.tsx:488  expect(reportDom).toContain("준비된 근거")
Received DOM contains "준비된 관련 자료 ... 준비 경로 사전 준비" (copy renamed, assertion not updated)
```
Other distinct failures:
- `App.test.tsx:852` expected `"내부 근거 · 승인됨(APPROVED)"`, received `"Internal source내부 관련 자료 · 승인됨(APPROVED)..."` — evidence badge copy/shape changed.
- `redirects a signed-out visitor ...` / `renders an explicit private navigation landmark`: `TestingLibraryElementError: Unable to find ... role "navigation" name "Private workspace"`.
- `translates sign-in ... without English gaps` fails on `heading "Private presentation control"` (ko: `"비공개 발표 제어"`).
- `approves a live candidate ...`: **timed out at 30002ms** (act-wait never settles).
- 14 fails in new `Console-led audience screen pairing` block: `Unable to find button "청중 화면 미리 열기"` / `"발표 시작"` / `"다음 슬라이드"`, `data-stage-pairing` attr undefined (`App.test.tsx:1627`), `HTMLDetailsElement` null (`:1993`) — feature not implemented in this tree.

**private-api-proxy.test.ts** (2 fails; ambient env only):
```
test.ts:106  Expected: "http://127.0.0.1:3001/v1/deck-uploads?mode=test"
Received: "http://private-backend:3001/v1/deck-uploads?mode=test"
```
The two pre-existing tests hardcode the default origin; `.env`'s `CONSOLE_PRIVATE_API_ORIGIN` overrides it. **3/3 pass** with `CONSOLE_PRIVATE_API_ORIGIN=http://127.0.0.1:3001`. The new `delivers an early upstream rejection` test passes in every env. Test is env-fragile (doesn't stub the env var), not a product defect.

**cockpit-rail.test.tsx** (2 fails):
```
cockpit-rail.test.tsx:201  drawer?.querySelector(".console-reference-documents")
expect(received).toBeTruthy()  Received: undefined
(fail) folds reference material away and promotes prepared evidence after start
(fail) keeps every rail capability reachable across both phases
```
Post-start drawer does not render `.console-reference-documents` inside `details.console-preparation-drawer` — rail-phase refold partially unimplemented.

**playback-panel.test.tsx** (1 fail):
```
playback-panel.test.tsx:170  expect(approvals).toEqual(["ps_active:display_room"])
Received: []
(fail) renders a dead-binding expiry in the problem state and keeps the anti-stranding path
```
Dead-binding expiry path never emits the expected rebind/approval request.

## Environment caveat

Under the ambient `NODE_ENV=production` (exported by this shell and present in
repo `.env:143`), React resolves its production build where `React.act` does not
exist. Every `.tsx` test that calls `@testing-library/react` `render` fails with
`TypeError: React.act is not a function` — including clean committed files
(`qa-defense-panel.test.tsx` 0/7, `debug-overlay.test.tsx` 0/6) and files
untouched by the dirty tree. This is an environment defect, not product code;
repro: `NODE_ENV=production bun test apps/console/src/evidence-card.test.tsx`.
Plan task 39 explicitly covers detecting `.env`/`NODE_ENV` leakage like this.

## Verdict

Files serve these plan tasks: App.test.tsx -> tasks 1, 16, 27, 28 and the audience-pairing work of task 12 (amendment 32); deck-upload.test.tsx -> tasks 17/30; private-api-proxy.test.ts -> proxy 413-forwarding hardening (amendment deploy/proxy scope, task 39-adjacent; also closes a GAP-15 upload-rejection seam); session-client.test.ts -> typed-client foundation for 12/16/37; cockpit-audio-capture.test.tsx -> task 34 (honest mic status); cockpit-rail.test.tsx, debug-toggle-placement.test.tsx, evidence-card.test.tsx, playback-panel.test.tsx -> tasks 29-33 rail/copy/pairing UI; locale-parity.test.ts -> tasks 29/38; presentation-report-page.test.tsx -> tasks 11/36. Defects found: `App.test.tsx` 23 fails under the correct test env — stale copy assertions (`:488` 준비된 근거 -> 준비된 관련 자료, `:852` badge copy), missing `navigation "Private workspace"` landmark (`:640s`), a 30s timeout in `approves a live candidate`, and the entire `Console-led audience screen pairing` suite red because invitation/pairing UI is unimplemented; `cockpit-rail.test.tsx:201` `.console-reference-documents` absent from the post-start drawer; `playback-panel.test.tsx:170` dead-binding anti-stranding emits no approval request; `private-api-proxy.test.ts` hardcodes the default origin and fails whenever `CONSOLE_PRIVATE_API_ORIGIN` is configured (2 fails, test-fragility only). Unimplemented for this scope: the audience-screen pairing/invitation surface (all 14 pairing tests red), the cockpit post-start rail refold, and playback dead-binding recovery.

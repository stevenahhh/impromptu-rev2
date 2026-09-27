# Task 12 + 31 (console side) — Stage invitation, visible identity, fresh-CAS approval

Console-side implementation of the plan-12 presenter experience on top of the plan-6/7
backend contract already in the tree. No backend, Stage, or contract files were touched;
work is confined to `apps/console/src` plus tests and this evidence.

## What changed

### New: `apps/console/src/display-invitations.ts`
- `issueDisplayInvitation` — POST `/v1/display-invitations` (credentials + CSRF), closed
  parse of the minted DTO; `stagePath` must match `/^\/\?deck=<id>#invite=dinv_<64hex>$/`
  or the call fails closed. The minted token is never re-exposed as a field.
- `readDisplayInvitationPending` — GET `/v1/display-invitations/:id/pending`, closed parse
  of the pending view (exact display id / fingerprint / deck / `displayBindingEpoch` CAS).
- `DisplayInvitationError` carries the verbatim backend `error` code + HTTP status.
- Wired onto `ConsoleSessionClient` (`console-client.ts`, `session-client.ts` re-exports).

### `display-playback.ts`
- `approveDisplay(csrf, presentation, join, expectedDisplayBindingEpoch)` now sends the
  epoch passed by the caller. The old hardcoded `"dbe_0"` is gone — this was the exact
  task-2 repro that made every rebind answer 409 STALE_DISPLAY_BINDING.
- New `DisplayApprovalRejectedError` carries the verbatim 409 `error` reason so the UI can
  distinguish stale CAS from other rejections instead of collapsing to a generic failure.

### `audience-screen.ts` (hook)
- New input `displayBindingEpoch` (held CAS or null) and optional `issueInvitation` /
  `readInvitation` closures wired from `workspace-page.tsx` to the real client.
- New `invitation` state machine: NONE → ISSUING → OPEN → JOINED | EXPIRED | OUTDATED |
  ISSUE_FAILED. `copyInvitationLink()` mints and returns `stageOrigin + stagePath`
  (fragment-token URL only); `checkInvitation()` performs the owner-scoped pending read.
- Pending joins are `{ join, epoch, invitationId }` records. Invitation joins surface the
  pending read's CAS (`pendingEpoch`); postMessage joins keep epoch null until bind.
- `bind` CAS order: pending-read epoch hint → held context epoch → fresh mint+read
  (the only owner-scoped epoch read). On `STALE_DISPLAY_BINDING` it refreshes the epoch
  once — re-reading the same invitation for invitation joins, mint-and-read otherwise —
  and retries. Same-epoch or unavailable refresh lands as `BIND_FAILED` with the reason.
- `BIND_FAILED` outcome now carries `reason`; controller exposes `failureReason`.
- Deck-version change clears pending record and invitation (a mint for the old deck could
  only produce rejectable joins).

### `audience-panel.tsx` / `playback-panel.tsx`
- "Copy presentation screen link" now mints a one-use invitation everywhere it appears —
  collapsed mid-talk state, expanded surface, and the POPUP_BLOCKED recovery — and writes
  `<stageOrigin>/?deck=<v>#invite=<token>` to the clipboard (token in fragment only; a
  readonly field shows the link when clipboard write is unavailable).
- Invitation block shows absolute expiry, a manual "Check connection request" control,
  and on JOINED the exact display id, fingerprint, deck, and binding CAS next to the
  explicit `[data-display-approve]` button. Nothing auto-approves.
- `data-audience-screen-panel`, the CONNECTED badge, and the playback caption no longer
  claim a connected screen while the last bind attempt is `BIND_FAILED` (stale-reopen fix).
- The opener-created same-device path is untouched: window.open + `impromptu:display-join`
  handshake + `display-bound` nudge all behave as before, now with a real CAS.
- 18 new locale keys added to both `ko.json` and `en.json` (parity test green); no
  unrelated copy changed.

## Tests (failing first, then implementation)

- `display-invitations.test.ts` (new, 8 tests): mint request shape, fragment-only token,
  malformed `stagePath` fail-closed, typed rejection codes, pending-view parse, CAS echo
  in the approval POST, `STALE_DISPLAY_BINDING` typed rejection.
- `audience-screen.test.tsx` (+13 tests): mint→OPEN, unredeemed check, JOINED surfaces
  identity+CAS, approval sends the read CAS, stale-CAS refresh+retry, unrefreshable stale
  → BIND_FAILED w/ reason, EXPIRED/unknown/wrong-deck handling, reload-with-null-epoch
  resolves fresh (never `dbe_0`), stale held epoch on opener rebind retries, opener path
  unchanged without resolver.
- `App.test.tsx` (+3 tests, full DOM flow): copy→check→identity→approve→CONNECTED;
  collapsed mid-talk surface expands once an invitation exists; refused rebind drops the
  connected badge instead of leaving a stale claim.
- `playback-panel.test.tsx`, `cockpit-rail.test.tsx`: stubs gained the two invitation
  client methods so their opener binds exercise the CAS-resolution path.

## Verification

- `NODE_ENV=test bun test apps/console/src` — 244 pass / 1 fail. The single failure
  (`private-api-proxy > early upstream rejection`) is PRE-EXISTING and unrelated:
  `cockpit-audio-capture.test.tsx` (unmodified) permanently replaces `globalThis.fetch`
  at module scope; whenever it is scheduled before `private-api-proxy.test.ts`
  (unmodified) the proxy test sees the 201 stub. Reproduces with
  `bun test apps/console/src/cockpit-audio-capture.test.tsx apps/console/src/private-api-proxy.test.ts`
  on the unmodified files. Both files pass in isolation.
- `bun run typecheck` — clean (root + ui + console + stage).
- `bun run lint` — only failures are pre-existing `apps/{console,stage}/.vercel/project.json`
  formatting complaints on git-ignored local artifacts; all changed files check clean.
- Browser QA (Playwright, real Chromium, real `next dev` console build of this worktree on
  :4185, `/v1/*` intercepted with contract-faithful fixtures because the running demo
  backend enforces the deployed console origin): sign-in → deck upload → copy link
  (clipboard = `http://127.0.0.1:4174/?deck=deck_qa#invite=<token>`, token absent from
  query) → check → identity block shows display id / fingerprint / deck / `dbe_2` →
  explicit approve → `POST /v1/display-bindings` carried `expectedDisplayBindingEpoch:
  "dbe_2"` → CONNECTED badge → expired invitation renders recovery copy. Screenshots and
  `browser-qa.log` beside this report. `BROWSER_QA_PASS`.

## Not done / boundaries

- Stage-side invitation consumption (`#invite=` landing, one-use exchange join) is sibling
  scope (plan task 13); the pending read was exercised against contract-faithful fixtures.
- Reload/resume: React state does not persist across a reload; after reload the console
  holds no epoch and resolves the CAS through a fresh mint+pending read before approving
  (proved by `audience-screen` tests + App reopen test).
- No git stage/commit performed, per instructions.

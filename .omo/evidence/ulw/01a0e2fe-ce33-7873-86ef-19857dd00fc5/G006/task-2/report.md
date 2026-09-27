# Plan task 2 — Stage pairing & asset-failure baseline (real browser, deployed topology)

Task id: st_01a0e3d5. Executed read-only against the **deployed** product (the plan's
one-machine loopback variant is superseded — a sibling lane had just deployed to Vercel):
Console `impromptu-rev2-console.vercel.app`, Stage `impromptu-rev2-stage.vercel.app`, both
proxying `/v1` over Cloudflare quick tunnels to this host's demo stack
(`impromptu-ulw-g003-demo-*`: private-backend :3001, projection-gateway :3002).
Browsers: two fresh task-owned Chromium profiles per scenario (deleted after capture).
No source files modified; `git status` shows only this evidence dir.

VERIFY (required): `env NODE_ENV=test bun test apps/stage/src/App.test.tsx` → **exit 0**
(9 pass / 0 fail, 274ms; `stage-app-test.log`).

## Acceptance answers (the three plan questions)

1. **Is an independent (second-device) Stage inert?** YES for the page, with a caveat.
   `independent-device.png` / `-mobile.png`: a no-opener browser at `/?deck=<v>` shows only
   the neutral Korean notice and issues **zero** `/v1/display-joins` calls
   (`results.json: independentJoinAttempts=0`). Caveat: the raw public API still mints a
   join locator for anyone — `POST /v1/display-joins` → **201** with no invitation, no
   cookie. The minted locator cannot attach: `POST /v1/display-session` →
   **409 `display_not_approved`**, `GET /v1/snapshot` → **401 `display_session_required`**,
   `GET /v1/events` → 401. So a second device is inert, but only because approval gates the
   claim — the unauthenticated locator mint remains open (GAP-2 territory).
2. **Does rebinding surface a CAS denial?** YES — **`POST /v1/display-bindings` → 409
   `{"error":"STALE_DISPLAY_BINDING"}`** on the Console's own close/reopen gesture
   (`rebind.http`). Deployed `approveDisplay` checks the live binding epoch privately;
   the Console client (`display-playback.ts`) still sends the constant `dbe_0`, so every
   UI reopen after a successful first bind lands a 409. Effect on screens: the reopened
   Stage sits at `/` with `data-audience-readiness="PAIRING"` (blank — `rebind-stage.png`),
   while the Console simultaneously shows the BIND_FAILED recovery line *and* a stale
   "발표 화면 연결됨" connected badge (`rebind-console.png`). Operator proof that fresh CAS
   works: the same route with `dbe_1`/`dbe_2` → **201** (`dbe_2`, `dbe_3` minted).
3. **Is READY blank when the verified SVG request fails?** YES. With `/v1/deck-assets/*`
   requests aborted, the Stage reports `data-audience-readiness="READY"` while the slide
   host mounts nothing (`hostEmpty=true`, `svgPainted=false`, 2 aborted requests —
   `asset-failure.png`, `-mobile.png`, both fully blank). Slide-only safety holds: the
   surface renders **no** content beyond an sr-only placement hint and zero bytes beyond
   the failed asset — `bodyText` contains only the placement instruction; cards/tombstones
   arrays in the snapshot are empty. The audience-facing failure mode is therefore
   "black screen that looks like a paused slide", which the pairing copy explicitly calls
   out as the bad state.

## Malformed / replayed invitation denial (exact statuses)

| Probe | Status | Body |
|---|---|---|
| POST /v1/display-joins `{}` | 400 | `invalid_request` |
| POST /v1/display-joins `invitationToken:"not-a-token"` | 400 | `invalid_request` |
| POST /v1/display-joins forged well-formed `dinv_ab…` | 404 | `INVITATION_UNKNOWN` |
| POST /v1/display-invitations unauthenticated | 401 | `account_session_required` |
| POST /v1/display-invitations (owner, ACTIVE) | 201 | minted `dinvite_…` + stagePath |
| Exchange once (valid token) | 201 | join locator |
| **Replay consumed token** | **409** | **`INVITATION_CONSUMED`** |
| Same token, wrong deckVersion | 409 | `INVITATION_DECK_MISMATCH` |
| Claim exchanged join w/o approval | 409 | `display_not_approved` |

Earlier run caveat (recorded honestly): the first battery's `displayFingerprint`
`fp_task2invited` was 15 chars (<16) so both exchange probes answered 400 `invalid_request`
— a probe-shape artifact, corrected and re-run in `invitations.mjs` (results above).

## Additional baseline defects observed

- **#invite URLs never exchange in the Stage UI.** The deployed Stage bundle contains the
  invitation schemas but `createJoin` never sends `invitationToken`, and nothing reads
  `location.hash` — an invited device at `/?deck=<v>#invite=dinv_…` lands on the inert
  notice (`invited-device.png`, visually identical to `independent-device.png`). Invitation
  tokens only work via raw `POST /v1/display-joins`.
- **POST /v1/presentation-sessions/:id/end → 500 `internal_error`** yet the lifecycle does
  flip to ENDED (verified in Postgres). `SessionReportAccessDeniedError` is thrown after
  the mutation — a typed-rejection miss.
- **WSS `/v1/realtime` fails through the Vercel proxy** (`Unexpected response code: 500`
  every attempt). Stage still reaches READY over SSE + HTTP receipts — WS is the
  non-fatal fast path.
- `ERR_CONTENT_DECODING_FAILED` on several console chunk/asset responses after sign-in
  (Vercel edge serving compressed payloads without matching headers). Non-blocking for
  pairing; flagged for the deploy lane.
- DOM probe note: `svgPainted` used HEAD class names; the deployed build renders through a
  different node shape — the opener.png screenshot is the authoritative paint evidence.

## Evidence inventory

```
task-2/
  report.md                      this file
  pairing.http                   every HTTP receipt (status + body, secrets redacted)
  rebind.http                    focused CAS receipts: 201 dbe_1 -> 409 STALE -> 201 dbe_2/dbe_3
  browser-actions.log            timestamped redacted browser/API action log
  results.json                   machine verdicts (independentJoinAttempts, uiRebind, ...)
  stage-app-test.log             env NODE_ENV=test bun test apps/stage/src/App.test.tsx, EXIT=0
  cleanup.txt                    cleanup receipts + non-revertible residue
  opener.png                     1440x900 opener-paired Stage: READY + slide 1 painted
  asset-failure.png              1440x900 READY-but-blank under blocked deck-assets
  asset-failure-mobile.png       390x844 same state on mobile
  independent-device.png         1440x900 no-opener Stage: inert notice
  independent-device-mobile.png  390x844 same on mobile
  invited-device.png             1440x900 #invite URL also lands inert (UI defect)
  rebind-stage.png               reopened Stage parked on PAIRING (blank)
  rebind-console.png             console post-reopen: BIND_FAILED copy + stale badge
  console-landing.png / console-after-signin.png / console-cockpit.png /
  console-after-upload.png / console-bound.png
  harness/{run.mjs,invitations.mjs,opener-server.mjs}
```

Plan-task evidence names honoured: `opener.png`, `independent-device.png`, `rebind.http`,
`asset-failure.png`, `cleanup.txt` — plus the task-requested desktop+mobile twins.

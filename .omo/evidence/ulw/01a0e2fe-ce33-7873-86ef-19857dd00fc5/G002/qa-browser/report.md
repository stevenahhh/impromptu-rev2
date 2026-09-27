# G002/C001+C002 — real-browser presenter-to-audience flow on production Vercel aliases

2026-09-27 (re-run after the Console proxy GET-body fix redeploy). Driver:
`drive.mjs` in this directory (playwright-core, task-owned persistent profiles
under `qa-browser/.profile-*`, both deleted after the run). Browser engine:
installed Chrome for Testing (playwright-core `chromium.executablePath()`;
`.env` `CHROME_EXECUTABLE_PATH` is empty). The parent plan's `browser`-skill
JS-eval "omowright" surface does not exist in this child harness (no Node REPL
tool), so the equivalent task-owned persistent-context path was used — the
contract it must satisfy (isolated task-owned profile, action/network log,
redacted URLs) is honoured. No credential, cookie, CSRF value, invitation
token, or private deck bytes appear in any artifact here; URLs are logged with
query and fragment stripped.

## What was driven (real browser, production aliases)

| Step | Result |
|---|---|
| GET `console…/sign-in` | 200, sign-in form rendered |
| POST `/v1/account-sessions` (sample presenter from `.env`) | 201, workspace reached |
| Post-sign-in surface | h1 "발표 자료를 올려 주세요", upload dropzone only — **no reentry for existing sessions (gap, see below)** |
| `setInputFiles` docs/samples/impromptu-sample-deck.pdf → POST `/v1/deck-uploads` | 201, cockpit rendered (new session `ps_8b7dd2560756cbdd6bec323c8c2c1b34`) |
| Click primary "발표 시작" → `window.open` Stage popup | popup opened `stage…/?deck=…` (query logged stripped) |
| Stage popup POST `/v1/display-joins` | 201 |
| Console POST `/v1/display-bindings` (auto-approve of own popup) | 201 |
| Stage POST `/v1/display-session` (claim) | 201 |
| Stage GET `/v1/events` (SSE) | 200, open |
| Console POST `/v1/playback/slide-set` | 202 |
| Stage GET `/v1/snapshot` | 200, `data-audience-readiness=READY` |
| Rendered slide proof | `img.stage-slide` complete, `naturalWidth=2560`, `aria-label="Impromptu sample deck — slide 1"`, `data-blackout=false` — pixels, not just HTTP 200 |
| Presenter advance → Stage follows | slide-1.png → slide-2.png on the audience surface |
| In-page GET `/v1/snapshot` (bound display cookie) | 200, `role=PUBLIC_STAGE`, `slideCount=7`, `displayBindingEpoch=dbe_1`, blackout=false |

## Exact HTTP statuses — Stage boundary and unauthenticated checks

Re-verified live against `https://impromptu-rev2-stage.vercel.app`:

| Request | Status | Body (public denial text) |
|---|---:|---|
| GET `/v1/snapshot` (no display cookie, curl + independent profile) | 401 | `{"error":"display_session_required"}` |
| GET `/v1/account-session` | 404 | `{"error":"not_found"}` |
| GET `/v1/presentation-sessions` | 404 | `{"error":"not_found"}` |
| GET `/internal/display-invitations` | 404 | Vercel plain-text NOT_FOUND |

Independent second task-owned profile (no opener, no shared cookies):

- `GET stage…/` → 200, renders `main.stage-console-only` inert notice
  ("발표 화면은 발표자 화면에서 열립니다…"), **zero `/v1/` requests** —
  a Stage URL alone cannot self-pair. `09-stage-alone-1440x900.png`.
- `GET /v1/snapshot` from that profile → 401.
- `GET stage…/display/rehearsal` → SPA not-found state, no readiness element —
  an arbitrary display URL without a bound session never reaches a slide.
  `10-stage-alone-display-1440x900.png`.

## Sample-deck reentry gap — still present (honest finding)

After real sign-in on the production Console, the first authenticated screen
is the upload dropzone ("발표 자료를 올려 주세요"). There is **no UI to resume
or list existing sessions**: `reentryControls=0`, and the seeded
`ps_07e713b6f8a1d6bb88cd4b0cc549cfb1` is never surfaced. This matches the
client design — `AuthProvider` holds `activePresentation` in memory only —
and is unchanged by the proxy redeploy (a server-side fix; the SPA still has
no restore path). The seeded session remains valid server-side per
`sample-deck-flow.md`, but a browser presenter cannot re-enter it; the deck
had to be re-uploaded to reach a presentable state. Task 37's server-backed
reentry is still required for the "existing deck" half of the criterion.

## Related limitation (unchanged this deploy)

`#invite=` fragments are never consumed by the deployed Stage build
(`stage-console-only` path is opener-gated; the `#invite` strings in the
bundle are contracts-schema only). Independent-device pairing is therefore
impossible in the UI; the Console-opener `window.open` + postMessage
handshake is the only working browser path and it works end-to-end.

## Artifacts

- `screenshots/01..10` — sign-in, workspace (gap), cockpit, rendered slide
  1440x900, presenting console, slide 2 after advance, Stage slide 375x812,
  console 375x812, stage-alone inert, stage-alone display 404-state.
- `action-log.json` — timestamped actions + redacted network log
  (method/host/path/status only).
- `drive.mjs` — the driver itself (contains no secrets; reads `.env` in-process).

Browser profiles were deleted post-run; the server-side session created for
this run remains until expiry (same note as the prior receipt).

# task-21 / task-41 read-review — release and customer docs vs current source

2026-09-27. Branch `feat/ideal-experience-deploy`. Reviewer: senpi-task worker `st_01a0e418`.
Patch reference: `.omo/senpi-task/isolation/st_01a0e404/root.patch` — used as a reference and
re-verified against the current working tree and the deployed aliases, not applied verbatim.

## Files changed (docs only; no source, tests, or manifests touched)

- `docs/DEMO-SCOPE.md` — rewritten to the slide-only demo contract.
- `docs/final-manual-qa.md` — venue flow rows 5/6 converted from public card approve/retract to
  negative card-ingress/private-leakage checks; invitation steps added; task-53 cited as
  historical at its commit.
- `docs/runbooks/venue-failure-recovery.md` — rewritten for slide-only Stage; selector names
  verified; added invitation/fingerprint failure section and Vercel/tunnel section.
- `docs/runbooks/vercel-demo.md` — new runbook for the Vercel + Compose + Cloudflare demo.
- `docs/samples/README.md` — demo path aligned with the real upload/invitation flow.

## Where the patch deviated from current source (corrected, not copied)

1. **Stale UI-gap claim.** The patch asserted "the Console client has no
   `/v1/display-invitations` call, and the Stage client does not pass `#invite` to `createJoin`."
   The current working tree carries both: `apps/console/src/display-invitations.ts` (untracked,
   `POST /v1/display-invitations` + `GET /v1/display-invitations/:id/pending` clients),
   `apps/console/src/audience-panel.tsx` (`data-stage-invitation` panel), and
   `apps/stage/src/landing-page.tsx` (`readInvitationFragment` parses `#invite=` against
   `DisplayInvitationTokenSchema`, passes the token to `createJoin`). However, the deployed
   Vercel build predates that wiring (proof below), so the docs now state: wiring exists in the
   working tree, the served bundles lack it, only the same-device opener path pairs on production
   today, and the separate-device invitation path remains a release gate until redeploy +
   real-browser exercise.
2. **WebSocket claim.** The patch draft mentioned "an HTTP receipt path when a WebSocket upgrade
   is not available." `apps/stage/src/stage-client.ts` uses `EventSource` (`GET /v1/events`) and
   `POST /v1/stage-applied`; no WebSocket exists. Docs say SSE + HTTP POST.
3. **`## Preregistered evaluation` removal.** The patch deleted the heading, which
   `scripts/verify-repo.ts` requires (`bun run check:repo` exit 1). Restored the section in
   concise form; `check:repo` now exits 0.

## Current-source verification of documented claims

| Documented claim | Verified at |
| --- | --- |
| Console routes: `/sign-in`, `/sign-up`, `/` + `/session`, `/presentations`, `/reports/:id`, `/live-publication` interstitial | `apps/console/src/console-routes.tsx` |
| Stage routes: `/` landing, `/display/:displayId` | `apps/stage/src/stage-routes.tsx` |
| Stage `#invite` fragment parsing + `createJoin(identity, deckVersion, invitationToken)` | `apps/stage/src/landing-page.tsx:21-93` |
| `POST /v1/display-invitations`, `GET .../pending` owner routes | `services/private-backend/src/http/routes/display-invitations.ts:20,63` |
| `POST /v1/display-bindings` owner route | `services/private-backend/src/http/routes/coordinator-commands.ts:84` |
| `POST /v1/display-joins`, `POST /v1/display-session`, `GET /v1/snapshot`, `GET /v1/events`, `POST /v1/stage-applied` public routes | `services/projection-gateway/src/http.ts:533,578,611,618,641` |
| `POST /internal/cards` → `410 stage_cards_disabled` | `services/projection-gateway/src/http.ts:439-440` |
| Invitation error codes `INVITATION_EXPIRED` / `INVITATION_CONSUMED`, <=90s TTL | `services/private-backend/src/http/routes/display-invitations.ts:8,39` |
| Readiness selectors `data-audience-readiness` (`READY`/`RECOVERING`/`SLIDE_FAILED`), `data-stage-slide-surface="uploaded"`, `data-blackout` | `apps/stage/src/display-page.tsx:104-130` |
| No Stage fullscreen/placement buttons; WMA placement runs automatically on mount | `apps/stage/src/display-page.tsx:152`, `use-screen-topology.ts` |
| Gateway `/health` + `/readyz` | `services/projection-gateway/src/http.ts:376-390`; compose healthchecks use `/readyz` |
| Console proxy envs `CONSOLE_PRIVATE_API_ORIGIN` (prod-required), `CONSOLE_DECK_ASSET_ORIGIN`; stage origin `STAGE_ORIGIN ?? NEXT_PUBLIC_STAGE_ORIGIN` → `window.__STAGE_ORIGIN` | `apps/console/src/next-runtime-config.ts`, `app/(console)/layout.tsx:19` |
| Stage Vercel `/v1/:path*` rewrite to live tunnel | `apps/stage/vercel.json` |
| Compose envs `CONSOLE_PUBLIC_ORIGIN`, `STAGE_PUBLIC_ORIGIN`; ports 3001/3002 on 127.0.0.1 | `compose.production.yaml:75-162` |
| `LIVE_PUBLICATION_GATE_STATE` unset/`BLOCKED` → live public off (`=== "PASSED"` enables) | `services/private-backend/src/config.ts:61` |
| task-53 receipt `28336976`: 13/13 gates, 577 tests, cohorts 10/10 p95 4,606.0/4,627.2 ms, `STAGE_ZERO_CARDS` | `.omo/evidence/task-53/receipts.json` |
| Sample deck `docs/samples/impromptu-sample-deck.pdf` exists | `docs/samples/` |

## Deployed-alias observations (live HTTP, 2026-09-27)

- `GET https://impromptu-rev2-stage.vercel.app/` → 200; served bundle `assets/index-xZohoKrS.js`
  contains zero `location.hash` reads (the `#invite` regex present is only the bundled contract
  schema), so the deployed Stage landing cannot consume an invitation fragment.
- Deployed Console chunks for `/sign-in` contain zero `invite`/`display-invitations` references —
  the served Console has no invitation-issuing UI.
- `GET /internal/display-invitations` on the Stage alias → 404 (not a public route; `/v1` only).
- `GET /v1/snapshot` without a display cookie → 401, no body bytes disclosed.
- `GET https://impromptu-rev2-console.vercel.app/sign-in` → 200.
- Prior task-2 receipt (`G002/sample-deck-flow.md`) recorded the full HTTP invitation contract
  live: invitation mint 201, exchange 201 pending-only, pending read `JOINED`/`dbe_0`, owner
  approval → `dbe_1`, claim 201 + display cookie, snapshot 200 slide-only, replay 409,
  cookieless snapshot 401.

## QA per plan row 21

- Negative grep over all five docs: zero hits for `candidate-approved`,
  `published-card-visible`, approve/retract card steps, `Enter fullscreen`, or
  `Place on target screen` as operator steps. No doc claims a prior automated run equals physical
  sign-off; the 10-run and task-53 records are explicitly labeled automated/historical stand-ins.
- `bun run check:repo` exit 0 (`repo-check.log`). `bun run check:browser-boundary` exit 0
  (`browser-boundary.log`). `git diff --check -- docs/` clean.
- Row 41's acceptance: documented buttons/routes match current Console/Stage source above; the
  only flow documented as conditional is the separate-device invitation UI, which is gated on
  redeploying the already-written tree code — never presented as a released capability; quick
  tunnels are described as temporary everywhere they appear.

## Non-blocking note

`git status` shows `UU` index conflicts on `apps/console/src/locales/{en,ko}.json` and a staged
but absent-HEAD landing page; these belong to other workers' in-flight lanes. They do not affect
the documented routes/selectors checked here, but no clean-tree typecheck claim is made in the
docs.

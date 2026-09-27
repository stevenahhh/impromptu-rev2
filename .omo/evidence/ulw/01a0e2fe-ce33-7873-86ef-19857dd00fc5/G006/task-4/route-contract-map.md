# Task 4 — authorization/private-public boundary baseline (route & contract map)

Plan: `.omo/plans/impromptu-ideal-experience.md` task 4 (closes GAP-3 baseline, GAP-5
baseline; Wave A, baseline only). Captured 2026-09-27 against the running demo stack
`impromptu-ulw-g003-demo-*` (private-backend 127.0.0.1:3001, projection-gateway
127.0.0.1:3002) plus HEAD source. Verdict: **boundary fails closed everywhere probed;
private-data attempts on the public gateway cannot reach private bytes.**

## Deployed-image drift (recorded, not "fixed")

The running images predate HEAD on two routes. Both still fail closed:

| Route | HEAD source | Deployed image (observed) |
|---|---|---|
| `POST /internal/display-invitations` (gateway) | bearer-gated, 201/400 (`http.ts:405+`) | `404 not_found` with bearer; `401` without (bearer check precedes) — see below |
| `GET /v1/presentation-sessions/:id/qa-defense` (private-backend) | owner-checked 200/404/403 (`qa-defense.ts`) | `400 invalid_request` (falls into coordinator-command body guard) |

Note on `GET /internal/display-invitations/:id` on the deployed image: observed `404`
without bearer because the route family is absent entirely, so the request falls through to
the terminal 404 **before** auth is evaluated. HEAD source answers `401
internal_unauthorized` first. Either way: no data, fail closed.

## Gate outputs

| Command | Exit | Artifact |
|---|---|---|
| `bun run check:boundaries` | 0 — `{"service":"projection-gateway","architecture":"valid"}` | `boundaries.log` |
| `bun run test:security` | 0 — 15 pass / 0 fail (4 files) | `security.log` |

## Public gateway 127.0.0.1:3002 (STAGE_ORIGIN = trycloudflare URL; enforced on headers)

Origin rules: `browserOriginHeaders` — any `Origin` != STAGE_ORIGIN -> `403
origin_forbidden` with no CORS headers; mutations also require Referer origin match -> `403
mutation_origin_forbidden`; non-GET to unknown paths -> `403 dispatcher_required`.

| Probe | Observed | Contract |
|---|---|---|
| GET /health | 200 ok | public probe |
| GET /readyz | 200 READY | public probe |
| GET /metrics, no bearer | 401 internal_unauthorized | internal bearer only |
| POST /internal/cards + valid bearer | **410 stage_cards_disabled** | retired card ingress |
| POST /internal/cards, no bearer | **401 internal_unauthorized** | bearer precedes card gate |
| POST /internal/cards, literal `local-development-token` | 401 internal_unauthorized | the token in the plan text is NOT the deployed `SERVICE_AUTH_TOKEN` — plan happy-path wording is stale |
| POST /internal/cards + bearer + private-marker claim body | 410, marker not echoed | gate fires before body parse |
| POST /internal/display-invitations + bearer | 404 (image drift) | see drift table |
| POST /v1/display-joins, strict-schema violation (extra `privateSourceUri` field) | **400 invalid_request** | closed DTO `PublicDisplayJoinRequestSchema` rejects unknown keys |
| POST /v1/display-joins, well-formed | 201 locator `{displayJoinId, displayId, deckVersion, displayFingerprint, expiresAtMs}` — no cookie, no binding | authority waits for presenter gesture |
| POST /v1/display-joins, foreign Origin | 403 origin_forbidden | |
| GET /v1/snapshot, no cookie | **401 display_session_required** | zero private bytes |
| GET /v1/snapshot, forged cookie | 401 display_session_expired | |
| GET /v1/events (SSE), no cookie | **401 display_session_required** | zero bytes |
| POST /v1/stage-applied, no cookie | 401 display_session_required | cookie read precedes body |
| POST /v1/stage-applied, forged cookie value + closed DTO | 409 receipt_rejected | cookie is read as a display session id; unknown id reaches the receipt writer, which refuses |
| GET /v1/realtime (WSS), no cookie | **403 DISPLAY_SESSION_REQUIRED** | pre-upgrade auth |
| GET /v1/realtime, no Origin | 403 ORIGIN_FORBIDDEN | |
| GET /v1/deck-assets/…%2e%2e escape | 400 invalid_asset_path | traversal closed |
| POST /v1/projections/ps_probe (direct write) | 403 dispatcher_required | no public write route exists |

Stage snapshot/SSE/WSS/ingress therefore expose **zero cards and zero private question
data** to anyone without a bound display cookie — and no path mints that cookie without a
presenter-approved binding (display-session claim returns 409 `display_not_approved`
unapproved; verified in release-security suite).

## Private backend 127.0.0.1:3001 (CONSOLE_ORIGIN = trycloudflare URL; enforced on headers)

Auth model (`handler.ts`): system routes (health/readyz/metrics/internal/stage-applied) ->
mutation origin gate (`403 mutation_origin_forbidden`) -> account entry routes
(/v1/accounts, /v1/account-sessions) -> **session cookie gate `401
account_session_required` / `401 ACCOUNT_SESSION_UNKNOWN` for forged values** -> CSRF gate
on non-GET (`403 csrf_rejected`) -> authed route groups.

Actors: **A** = `account_production` (controller bootstrap, owns session
`ps_ad14d071bfe1476e90847cef95ec3ea8`); **B** = `boundary-probe-b` (`account_607f4dfb…`,
signed in, owns nothing); **C** = anonymous.

| Probe | Observed | Meaning |
|---|---|---|
| A sign-in POST /v1/account-sessions | 201 + `__Host-account` cookie + csrfToken | identity works |
| A GET /v1/account-session | 200 | self-read |
| A GET /v1/publications/live-candidates, own session | 403 PUBLICATION_AUTHORITY_REQUIRED | ownership passed; publisher-actor grant predates this fresh sign-in (per-sign-in actorId) |
| A GET live-candidates, nonexistent session | 403 PRESENTATION_NOT_FOUND | distinguishable typed denial |
| **B POST /v1/qa-defense on A's session (session-question submit)** | **403 `{"error":"unauthorized"}`** | B's current inability — the GAP-5 baseline: no teammate question-entry surface exists |
| B GET /v1/publications/live-candidates on A's session | 403 UNAUTHORIZED | cross-account read denied |
| **B POST /v1/publications/teammates self-grant on A's session** | **403 UNAUTHORIZED** | no teammate grant observed; B cannot mint one itself |
| B POST /v1/publications/approve | 410 stage_cards_disabled | private-side card route also retired |
| B POST /v1/qa-defense without CSRF | 403 csrf_rejected | CSRF precedes authorization |
| B GET …/qa-defense (recheck) | 400 invalid_request | deployed-image drift; still closed |
| **C POST /v1/qa-defense (no cookie)** | **401 account_session_required** | C's denial — anonymous cannot submit |
| C GET /v1/account-session | 401 account_session_required | |
| C GET live-candidates | 401 account_session_required | |
| C GET /v1/playback/controller-events (private SSE) | 401 account_session_required | zero bytes |
| C POST /v1/qa-defense, forged cookie | 401 ACCOUNT_SESSION_UNKNOWN | |
| C POST /v1/qa-defense, no Origin/Referer | 403 mutation_origin_forbidden | origin gate precedes auth |
| C POST /internal/stage-applied, no bearer | 401 internal_unauthorized | internal lane |
| C POST /v1/accounts, malformed | 400 invalid_request | closed DTO |

## Contract anchors (HEAD)

- `services/projection-gateway/src/http.ts:340-403` — non-GET dispatch guard, internal bearer
  + `/internal/cards` 410; `:532-660` public v1 routes (joins/session/events/receipts/
  snapshot/deck-assets).
- `services/projection-gateway/src/main.ts:135-161` — `/v1/realtime` pre-upgrade auth.
- `services/projection-gateway/src/realtime.ts:112-141` — ORIGIN_FORBIDDEN /
  DISPLAY_SESSION_REQUIRED / RATE_LIMITED rejection reasons.
- `services/private-backend/src/http/handler.ts:30-52` — mutation-origin -> cookie -> CSRF
  pipeline.
- `services/private-backend/src/http/routes/playback-read.ts:11-18` — private-side
  publications approve/terminate 410 gate.
- `services/private-backend/src/http/routes/qa-defense.ts:158-232` — open-window + ask
  routes; `resolveQaSession` yields 403 `unauthorized` to non-owners (B baseline above).
- `services/private-backend/src/http/routes/coordinator-commands.ts:142-154` +
  `prepared-evidence.ts:1174-1197` — teammate grant requires owner session AND current
  publication-authority actorId; no self-grant path observed.
- `packages/contracts/src/public-protocol.ts:52-65` — `PublicStageSession` /
  `AudienceSnapshot` strict schemas; snapshot schema enforces card/tombstone watermark
  invariants.
- `tests/security/release-security.test.ts` — 5 release-gate tests green (private-scope
  rejection at all 7 public write surfaces, 16 anonymous-route 401s, cross-tenant 403,
  compromised-Stage containment, tombstone restore discard).

## Baseline conclusions

1. Card ingress is dead on both services: `410 stage_cards_disabled` (GAP-3 baseline).
2. No teammate question channel exists; B is denied 403, C 401 (GAP-5 baseline). **No
   teammate grant was observed or created** — `/v1/publications/teammates` self-grant
   attempt from B returned 403.
3. Stage snapshot/SSE/WS and every ingress route return zero private bytes without a bound
   display session; closed DTOs reject private-scope payloads before state mutation.
4. Deployed images are older than HEAD (missing display-invitations + GET qa-defense
   recheck) — a deployment-freshness finding for later tasks, not a boundary hole.
5. Residue: `boundary-probe-b` account row persists (no delete API); all sessions revoked;
   probe join expired unclaimed. See `cleanup.txt`.

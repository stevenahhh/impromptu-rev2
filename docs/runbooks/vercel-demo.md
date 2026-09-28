# Vercel demo runbook

This runbook covers the current review demo. It is not a production deployment guide and it does
not certify a venue. Vercel serves the two browser apps. Compose owns the stateful services.
Tailscale Funnel provides a stable, fixed-hostname HTTPS ingress between them (no per-restart rotation).

## Topology

| Component | Current location | Purpose |
| --- | --- | --- |
| Console | `https://impromptu-console.vercel.app` | Private presenter app and server-side private API proxy |
| Stage | `https://impromptu-stage.vercel.app` | Public slide-only app |
| private-backend | Compose `127.0.0.1:3001` | Accounts, decks, owner controls, private data |
| projection-gateway | Compose `127.0.0.1:3002` | Display invitations, public slide state, SSE, receipts, and public assets |
| PostgreSQL and migrations | Compose internal network | Durable private and projection state |
| Tailscale Funnel :443 | Stable HTTPS origin `pro-square.tail9c00c4.ts.net` → private-backend 3001 | Vercel Console private-API and audio proxy |
| Tailscale Funnel :8443 | Stable HTTPS origin `pro-square.tail9c00c4.ts.net:8443` → projection-gateway 3002 | Stage `/v1` rewrite and Console deck-asset proxy |

The Stage Vercel project rewrites `/v1/:path*` to the projection-gateway funnel origin (:8443). Keeping
that API path on the Stage origin preserves the display cookie and the browser SSE event path; the
applied receipts ride on plain HTTP POST. Vercel should not be treated as the owner of PostgreSQL
or deck artifacts.

Console rewrites `/v1/audio/:path*` through the edge instead of its Node API proxy. Audio capture
opens `/v1/audio/events` with an authenticated, CSRF-protected POST stream: quick tunnels buffer
the body of GET SSE until the stream closes, preventing the browser from receiving READY. After
redeploying Console or private-backend, verify READY on the POST stream and at least one
`/v1/audio/frames` response with status 202 in a browser using the demo account.

The aliases above are the demo project domains. The funnel hostname is bound to the tailnet node and does not rotate on reconnect; treat it as the stable demo ingress.

## Start the demo stack

Use a task-owned account, deck, and browser profile. Keep `.env.production` outside version control.

1. Set `CONSOLE_PUBLIC_ORIGIN` to the Console alias and `STAGE_PUBLIC_ORIGIN` to the Stage alias
   in the Compose environment. The projection gateway must validate the exact Stage origin.
2. Start the stateful services from the repository root:

   ```sh
   docker compose --env-file .env.production -f compose.production.yaml config --quiet
   docker compose --env-file .env.production -f compose.production.yaml up -d --remove-orphans
   docker compose --env-file .env.production -f compose.production.yaml ps
   ```

   Do not add `--volumes`. Inspect a failed migration instead of bypassing it.
3. Expose both backends through Tailscale Funnel on this host (a non-App-Store / standalone or
   funnel-capable Tailscale variant is required for funnel port sharing; verify
   `tailscale funnel status` shows both mounts):

   ```sh
   tailscale funnel --bg 3001
   tailscale funnel --bg --https=8443 http://127.0.0.1:3002
   ```

   The public origins are then `https://<node>.<tailnet>.ts.net` (443 → private-backend) and
   `https://<node>.<tailnet>.ts.net:8443` (8443 → projection-gateway). Check each origin's
   `/readyz` response. Do not record credentials, cookies, invitation tokens, or response bodies
   that contain deck data.
4. Set the Vercel environment values for the current deployment:

   - Console `CONSOLE_PRIVATE_API_ORIGIN` is the private-backend funnel origin.
   - Console `CONSOLE_DECK_ASSET_ORIGIN` is the projection-gateway funnel origin.
   - Console `STAGE_ORIGIN` or `NEXT_PUBLIC_STAGE_ORIGIN` is the Stage Vercel origin.
   - The Stage rewrite destination in `apps/stage/vercel.json` is the projection-gateway tunnel
     origin followed by `/v1/:path*`.
5. Deploy both Vercel projects from the monorepo root. A project configured only with
   `apps/console` or `apps/stage` as a remote upload root can miss the workspace packages. Confirm
   both aliases report `Ready` before opening the demo.
6. Check the browser entry points:

   - Console `/sign-in` returns the sign-in page.
   - Console `/` returns the private workspace after authentication.
   - Stage `/` is inert until the Console flow opens or invites it.
   - Private-backend `/health` and projection-gateway `/health` return healthy responses through
     their private tunnel origins.

If exported shell variables still contain a previous tunnel, they can override `.env.production`. Unset stale
origin variables or override them at the Compose command boundary, then inspect a redacted
`docker compose config` result before recreating only the affected backend and gateway services.
Do not delete PostgreSQL or deck-artifact volumes during tunnel rotation.

## Account and deck setup

1. Use the configured task-owned controller account, or create a task-owned account at Console
   `/sign-up` when account creation is enabled. Never use a participant or production account.
2. Sign in at Console `/sign-in` and work from Console `/` or `/session`.
3. Upload `docs/samples/impromptu-sample-deck.pdf` or the generated PPTX. Wait for the upload and
   public slide render to complete before inviting Stage.
4. Keep the account cookie, CSRF value, deck version, and invitation secret out of URLs, logs,
   screenshots, support tickets, and browser storage outside the intended session.

## Secure Console and Stage flow

For an independent Stage device, the owner creates a one-use invitation for the active deck. The
contract is:

1. `POST /v1/display-invitations` returns a short-lived (<=90 second) non-authorizing invitation.
2. The Stage path carries the token in a fragment, such as
   `/?deck=<deckVersion>#invite=<token>`. It must not carry the token in a query string.
3. Stage exchanges it once at `POST /v1/display-joins`. The result is a pending locator, not a
   display cookie or binding.
4. The owner reads `GET /v1/display-invitations/:invitationId/pending`, checks the exact display
   ID, fingerprint, deck version, and binding epoch, and explicitly approves
   `POST /v1/display-bindings`.
5. Stage claims `POST /v1/display-session`, then reads `GET /v1/snapshot` and `GET /v1/events`.
   Console sends absolute slide selections and waits for `POST /v1/stage-applied` receipts.
6. The public Stage route is `/display/:displayId`. Its visible state must be a public slide. The
   Stage DOM and network responses must contain no cards, candidates, questions, transcripts,
   private source details, account data, or provider data.

The independent-device path was exercised at the deployed aliases: a separate Stage browser
context consumed a fresh invitation, the owner approved its fingerprint, and Stage rendered a
public slide. Recheck that path after rotating either tunnel or redeploying either app. Do not
replace it with a bare Stage URL or a manual join object.

## Negative checks

Run these from a private operations context with redacted output:

- Exchange the same invitation twice. The first exchange can create one pending locator. Replay
  must be rejected and must not create a second locator or cookie.
- Try an expired invitation, wrong deck, malformed token, forged fingerprint, wrong owner, stale
  epoch, and Stage claim before approval. Each must fail closed.
- Request `GET /v1/snapshot` and `GET /v1/events` without an approved display cookie. Expect a typed
  denial and no private bytes.
- With the internal bearer held only in the operator secret store, probe `POST /internal/cards`.
  Expect `410 stage_cards_disabled`. Never place the bearer in a screenshot or evidence file.
- Request `/internal/display-invitations` from the public Stage alias. It must not be a public
  browser route. The Stage Vercel rewrite covers `/v1` only.
- Inspect a public snapshot and slide asset response for account IDs, CSRF values, private deck
  text, candidate IDs, questions, transcripts, source hashes, and authorization tokens.

## Tunnel rotation

Funnel hostnames are stable; rotation applies only when the tailnet node or ports change.

1. Confirm the old tunnel is unavailable and stop its process. Start fresh private-backend and
   projection-gateway tunnels. Check both `/health` endpoints.
2. Update the ignored local environment with the new private and projection origins. Keep the
   public Vercel aliases unchanged. Set Compose `CONSOLE_PUBLIC_ORIGIN` and `STAGE_PUBLIC_ORIGIN`
   to those aliases, not to the tunnel hostnames.
3. Update the Stage rewrite destination in `apps/stage/vercel.json`. Update the Vercel values for
   `CONSOLE_PRIVATE_API_ORIGIN`, `CONSOLE_DECK_ASSET_ORIGIN`, and the Stage origin value. Do not
   commit a one-off tunnel hostname as a product default.
4. Recreate or rebuild private-backend and projection-gateway as needed. Preserve PostgreSQL,
   invitation, and deck-artifact volumes. Confirm the containers report healthy.
5. Redeploy both Vercel projects from the monorepo root. Verify Console `/`, Console `/sign-in`,
   Stage `/`, the two tunnel health endpoints, a task-owned sign-in, a fresh deck upload, a fresh
   invitation, fingerprint approval, and a public slide snapshot.
6. If any check fails, keep the emergency public artifact on the display and do not announce the
   demo as recovered.

## Privacy and hardware boundary

Vercel and Cloudflare are transport and app delivery layers. They do not change the Console and
Stage data boundary. Keep Console private, keep Stage public-only, and keep all provider calls on
private services. Never paste a secret-bearing URL into a public chat or issue.

A macOS browser run can verify routes, API denials, invitation contracts, and public response
shapes. It cannot verify Windows Extend or Duplicate, a projector, GPU or EDID, physical pixels,
captive portal behavior, a clicker, a screen reader, or operator response time. Those checks belong
to the physical Windows venue gate in `docs/final-manual-qa.md`.

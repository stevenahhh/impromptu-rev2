# Impromptu zero-cost deployment — research and execution ledger

Status: live ephemeral deployment via Cloudflare Quick Tunnel (account-free, $0) is
running from this workstation. Console: https://mainstream-dept-happening-promo.trycloudflare.com ·
Stage: https://point-alan-creation-membership.trycloudflare.com. The full presenter→audience
flow was verified over public HTTPS. Durable $0 hosting still wants OCI Always Free; the tunnel
dies with this machine/session. AI (generation/rerank/STT) is disabled — OpenCode Go is $10/mo
and no free 768-dim embedding endpoint exists.
Tier: HEAVY — public ingress, private sessions, persistent PostgreSQL and external hosting.
Goal: run Console, Stage, private backend, projection gateway and ingestion at publicly
reachable HTTPS origins without paid infrastructure, then verify the real browser flow.

## Decision and sources (2026-09-25)

The first-party [Oracle Always Free limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
currently allow one Ampere A1 VM with **2 OCPU, 12 GB RAM and 200 GB total block storage**
in the tenancy's home region. [Signup](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)
usually requires a phone and card, although Always Free resources need no paid upgrade.
The chosen target is that one VM, subject to the owner supplying OCI access, region capacity
and confirming an Always Free shape before provisioning. Free instances can be reclaimed when
idle; this cannot be treated as production availability.

Alternatives fail the complete-stack contract:

| Host | First-party boundary | Outcome |
| --- | --- | --- |
| [Google Cloud Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features) | e2-micro and small disk/network quota | Too little RAM for five containers and first build. |
| [Render Free](https://render.com/docs/free) | Postgres expires after 30 days; web service sleeps and has ephemeral filesystem | No durable complete deployment. |
| [Cloudflare Workers Free](https://developers.cloudflare.com/workers/platform/pricing/) | Edge CPU/memory/runtime limits; no Docker PostgreSQL | Only suitable for static sub-surfaces after redesign. |
| [Fly.io](https://fly.io/docs/about/pricing/) | Billed Machines and persistent volumes | Not an indefinite $0 stack. |
| [OpenCode Go](https://opencode.ai/docs/go/) | $10/month subscription | Cannot promise live recommendation at $0 by using the existing configured service. |

Existing `compose.production.yaml` already has PostgreSQL 17, ordered migrations, Bun
services, Next.js Console and Nginx Stage. One host runs Compose plus Caddy TLS:
`console.<ip>.sslip.io` -> localhost:4173, `stage.<ip>.sslip.io` -> localhost:4174,
`private-api.<ip>.sslip.io` -> localhost:3001. Stage's own Nginx serves `/v1` from
the Stage origin and proxies SSE/WebSocket to the internal projection gateway; never
publish the gateway or PostgreSQL. Use an owner-controlled hostname instead if provided.
[sslip.io](https://sslip.io/) resolves IP-embedded names, but this third-party free DNS
does not guarantee uptime; TLS issuance and DNS must be proved on the actual VM.

The backend image includes LibreOffice and Korean/English Tesseract but **not** an ARM
Whisper binary/model, ffmpeg, or a local HTTPS 768-dimension embedding server. Compose
now passes empty optional audio paths, so the model router disables the audio adapter and
its routes fail closed. Model API keys and a real embedding endpoint remain unavailable;
use no purchased provider for a "free" claim. Existing `OPENCODE_ZEN_API_KEY`
availability on the workstation does not authorize paid traffic. The user did not answer
the free-demo versus full-AI or cloud account question within the request timeout; choose
an explicitly limited local demo, not paid AI. No service is externally deployed yet.

## Dependency order

1. Preserve the current dirty worktree and fix only task-owned deployment/config files.
2. Verify ARM64 image support and build/Compose configuration; prepare Caddy ingress
   with Console/Stage host ports loopback-only and no gateway/database ingress.
3. Confirm OCI Always Free account, home region, available 2 OCPU/12 GB shape, VM
   public address, HTTP/HTTPS firewall and DNS; no paid resource or upgrade.
4. Provision durable storage/secrets and the selected free AI profile. Build images,
   run ordered migrations, health checks and production security gates.
5. Drive public Console/Stage via a real browser: owner login, sample deck upload,
   explicit display approval, visible slide and report; capture private rejection,
   reconnect and public-only Stage evidence.
6. Record observed quota, backup/restart behavior and teardown only for task-owned
   QA resources. Do not remove persistent app data with `down --volumes`.

## Scenarios and evidence targets

- Happy: `curl -i https://console.<ip>.sslip.io/health` and
  `curl -i https://stage.<ip>.sslip.io/health` each return `200`; omowright
  signs in at `/sign-in`, uploads a sample PDF, approves Stage, and screenshots
  the same visible slide on the audience profile.
- Boundary: `curl -i https://stage.<ip>.sslip.io/v1/snapshot` with no display
  cookie returns `401`, public TCP 3001/3002/5432 cannot connect, and no private
  transcript/candidate/card reaches Stage DOM, SSE or WebSocket.
- Build: `bun run check`, `uv run --project services/ingestion pytest`, Docker
  image builds for `linux/arm64`, and ordered migrations all return exit 0.
- Durability: restart Compose without deleting volumes; previously authenticated
  owner session and public deck metadata recover under their authorization.
- Cost: capture actual OCI shape/quota, volume/egress selection and monthly cost
  estimate at $0 before and after deploy; no paid subscription inference.

Evidence lives under `.omo/evidence/ulw/<session>/G003-*/a1/`; URLs, redacted HTTP
dumps, logs, screenshots, operator cleanup receipts and any unresolved dependency
must be linked to the loop criteria. Placeholders `<ip>` are resolved only after
the VM public address exists; they are not a claim of a deployment.

## Verified local demo (zero paid services)

On the ARM Compose stack (`impromptu-ulw-g003-demo`, loopback ports 44981–44984) with the
bootstrap account the complete presenter→audience chain was exercised end to end:

1. Console sign-in `POST /v1/account-sessions` → 201 (bootstrap `presenter` account).
2. Deck upload `POST /v1/deck-uploads` (XHR + `x-csrf-token`) → 201, `deck_16d0…` with 6 slides.
3. Stage `POST /v1/display-joins` → 201 (`display_` prefixed id + fingerprint ≥16 chars).
4. Console `POST /v1/display-bindings` → 201 (`binding_ace6…`, epoch `dbe_1`).
5. Stage `POST /v1/display-session` → 201, issued `SameSite=Strict; HttpOnly` `display=` cookie.
6. `GET /v1/snapshot` → 200 with full public deck; `GET /v1/events` → SSE opened (`: ready`).
7. `POST /v1/playback/lease-takeover` → 200 (`lease_66a6…`, `ce_2`), then
   `POST /v1/playback/slide-set` → 202 ACCEPTED (`baseRevision` uses `cr_` prefix).

Two code fixes were required and are now in the tree: `apps/console/Dockerfile` copies
`packages/contracts` + `packages/state`, and `services/model-router/package.json` declares the
`@impromptu/contracts` workspace dependency. `next-runtime-config.ts`/`next.config.ts` now allow
`http://private-backend:3001` as the server-side Compose hop only; `next-config.test.ts` covers
that exception plus rejection of other http hosts.

## Verified public HTTPS demo (zero paid services)

Cloudflare Quick Tunnels expose the loopback-bound Compose stack. Verified externally:
Console 200 / sign-in → upload 201 → Stage join 201 → approve 201 → session 201
(`__Host-display`, Secure, HttpOnly, SameSite=Strict) → snapshot 200 (6 slides) → SSE open →
lease-takeover 200 → slide-set 202. Public-side probes: POST /v1/deck-uploads on Stage → 403;
/internal/* → SPA shell only; backend and Postgres never leave 127.0.0.1.

## Live deployment operations

The deployment is live on Cloudflare Quick Tunnels backed by the local ARM Compose stack
(`impromptu-ulw-g003-demo`). It is ephemeral: URLs die when cloudflared or this machine stops.
Teardown: `kill` the two cloudflared processes (bash_34, bash_35), then
`docker compose -p impromptu-ulw-g003-demo -f compose.production.yaml down --volumes` and
`colima stop`. No cloud account, DNS record, or paid resource was created, so cleanup cost is
$0 and there is nothing to reclaim outside this machine.

Security notes: backend and Postgres stay on 127.0.0.1; only Console and Stage traverse tunnels.
The demo still uses the `.env.example` bootstrap password — rotate it if the URLs are shared
widely. Decks/audio stay on this machine; nothing is sent to a hosted AI provider.

## Preparation observations

- `docker compose --env-file .env.example -f compose.production.yaml config --quiet`
  exited 0; rendered Console 4173, Stage 4174, backend 3001 and gateway 3002
  bindings are all `127.0.0.1`, and PostgreSQL has no host port.
- `caddy validate --config infra/deploy/Caddyfile --adapter caddyfile` with
  non-secret example hostnames exited 0. Private API ingress blocks `/internal`
  and `/internal/*`; real TLS issuance and remote ingress are **not yet tested**.
- The initial `bun run check` failed because the formatter read newly generated
  `.omo/ulw-loop` JSON and an existing untracked `.tmp-docx/` scratch directory.
  `biome.json` now excludes only those generated directories; `bun run lint`
  subsequently exited 0 and checked 502 files. Product lint rules remain enabled.
- The first `uv run --project services/ingestion pytest` run had 131 pass, 2 fail
  because `/opt/homebrew/bin/soffice` pointed to a missing app under
  `/Applications/LibreOffice.app`. `brew reinstall --cask libreoffice` completed
  with exit 0, but the host binary still hangs and the second host Python run
  again ended with 131 pass, 2 render timeouts. The Linux container test result
  below exercises the deployed executable instead.
- `gh` is authenticated for the public repo, but neither an OCI CLI/account
  config nor a Google Cloud config is available. No Docker daemon was running;
  local ARM64 Colima installation was completed. Neither fact proves cloud access.
- `docker compose --env-file .env.example -f compose.production.yaml build`
  exposed a missing `packages/contracts` and `packages/state` copy in the
  Console Dockerfile. After adding those two workspace copies,
  `docker compose --progress=plain --env-file .env.example -f
  compose.production.yaml build console` exited 0. The Stage, gateway and
  backend images also exist as ARM64 images. A subsequent **full four-service**
  `docker compose --progress=plain --env-file .env.example -f
  compose.production.yaml build` exited 0. The first failing build is retained
  as the reproduction, not misrepresented as passing.
- The production backend image runs LibreOffice 7.4.7.2 and, with read-only
  test fixtures mounted, its Python ingestion suite finished **133 passed**.
  The repaired host macOS cask still hangs on `soffice --version` and caused
  2 host-only render test timeouts; no host-suite pass is claimed.
- The production `database-migrate` service applied both private and
  projection migrations under the isolated `impromptu-ulw-g003` Compose
  project and exited 0. Its task-owned containers and named volumes were
  removed after local QA; these are not a remote deployment.
- An isolated ARM Compose run brought PostgreSQL and projection gateway to
  healthy and started Stage. HTTP checks: Stage `/` returned 200 with Stage
  HTML; gateway `/readyz` returned 200 `{"outcome":"READY"}`; gateway
  `/internal/cards` returned 404, and the Stage `/internal/cards` SPA
  fallback contained no private data. Stage `/v1/readyz` returned 404,
  confirming it is not a valid public health endpoint.
- The host `bun test` run finished **796 pass, 12 fail, 1 error**. Failures
  are separated in `/tmp/impromptu-ulw-g003-tests.xml`: the host
  LibreOffice hang; E2E harnesses that start the gateway without the
  now-required `PROJECTION_DATABASE_URL`; one Stage fullscreen locator
  timeout; four database integration cases without local port 5432; and
  two tests whose global happy-dom fetch has been closed. These are not
  represented as a passing full gate or attributed to the deploy edits.
- The independently invoked `bun run check:browser-runtime` also exited 1:
  the Stage landing view rendered one `main` but no `h1` (the browser
  accessibility matrix requires one). This predates the deployment
  configuration and remains open; do not claim browser gate green.

# Vercel / deploy surface record — captured 2026-09-27, HEAD c4bb6ae

Task: record the current Vercel/deploy surface so Gate F3 (per `.omo/ulw-loop/.../goals.json` G002 /
plan row F3 and the `G-D` deploy wave in `brief.md`) can read it later. **No infra edits were made.**
Scope: evidence report only — this file is the sole change.

## 1. Vercel account state (verified this session)

| Fact | Evidence |
|---|---|
| Vercel CLI available via `bunx vercel`, version 60.1.3 (Node.js 26.7.0) | `bunx vercel --version` → `Vercel CLI 60.1.3` |
| Authenticated as `stevenahhh` | `bunx vercel whoami` → `stevenahhh` |
| Zero projects under the `gahn` scope | `bunx vercel project ls` → `No projects found under gahn` |
| No `.vercel/` link dir and no `vercel.json` anywhere in the repo | `find . -name 'vercel*.json' -o -name '.vercel'` → nothing |
| No CI deploy step | `grep -niE 'deploy|vercel' .github/workflows/ci.yml` → no matches |

The reference project named in the brief exists on another checkout:
`/Users/gahn/projects/99-aibootcamp-vibecoding/.vercel/project.json` =
`{"projectId":"prj_Vu9umfxwLrKb5qVuCJIe9tBAHCOL","orgId":"team_xxLhxtjunho7MVUEbXICGVmC","projectName":"projectnmbd"}`.
Auth for this repo's deploys is already unblocked — linking/deploying is a `bunx vercel link`
+ `bunx vercel --prod` away, no user auth needed.

## 2. Intended target topology (from brief/goals)

Vercel hosts the two PWAs; the backend stays on this host in Compose behind Cloudflare
quick tunnels:

- **Console** = `apps/console` — Next.js 15.4.11 (react 19.1.1), scripts `dev/build/preview`
  on port 4173. Next 15 is Vercel-deployable as-is. It carries server route handlers:
  - `apps/console/src/app/(console)/v1/[...path]/route.ts` → `proxyPrivateApi` (`src/private-api-proxy.ts`)
    — server-side proxy to the private backend public origin, driven by env
    `CONSOLE_PRIVATE_API_ORIGIN` (validated in `next.config.ts`: must be exact HTTPS origin in
    production; `http://private-backend:3001` allowed only as the Compose-internal hop).
  - `apps/console/src/app/(console)/v1/deck-assets/[...path]/route.ts` → `src/deck-asset-proxy.ts`.
  - Build/runtime env: `CONSOLE_PRIVATE_API_ORIGIN`, `NEXT_PUBLIC_STAGE_ORIGIN`,
    `NEXT_PUBLIC_SW_COHORT`, `NEXT_PUBLIC_CO_RESIDENT_CONSOLE` (Dockerfile build args), plus
    runtime `STAGE_ORIGIN` injected into `window.__STAGE_ORIGIN` by `(console)/layout.tsx:19-30`
    (blank-override guarded; `src/stage-origin.ts` falls back to build-time then
    `http://localhost:4174`).
- **Stage** = `apps/stage` — Vite static bundle, port 4174 dev / 8080 in its nginx image.
  Deliberately **no baked API origin** (`apps/stage/Dockerfile` builder comment +
  `vite-runtime-config.ts`): the audience session arrives as a `SameSite=Strict` cookie, so the
  origin serving Stage must also proxy `/v1` to the projection gateway — in Compose the nginx
  image does this (`location /v1/ { proxy_pass http://projection-gateway:3002; ... }` with
  WebSocket upgrade + `proxy_buffering off` for `/v1/events` SSE). **On Vercel this requires a
  `vercel.json` with a SPA fallback plus `/v1/*` external rewrites to the tunneled gateway
  origin** — that file does not exist yet and is the missing piece for a Stage deploy.
  Vercel cannot carry the WebSocket upgrade; `vite-runtime-config` notes Stage already supports
  SSE + HTTP receipt fallback, which survives a proxied rewrite.
- **Backend (never on Vercel):** `compose.production.yaml` — `postgres:17.6-alpine`,
  `database-migrate`, `private-backend` (Bun, 3001), `projection-gateway` (Bun, 3002),
  `ollama` + `embedding-model-init` + `embedding-tls` (Caddy TLS terminator so the
  HTTPS-only egress rule holds), `console` (4173), `stage` (8080→4174). All published ports bind
  `127.0.0.1`. Alternative documented edge: `infra/deploy/Caddyfile` (three vhosts, `/internal/*`
  denied on the private API host). Required env per runbook `docs/runbooks/deploy-production.md`:
  `CONSOLE_PUBLIC_ORIGIN`, `STAGE_PUBLIC_ORIGIN`, `CONSOLE_PRIVATE_API_ORIGIN`,
  `SERVICE_AUTH_TOKEN`, DB passwords, `CONTROLLER_*` seed creds, `CHAT_MODEL_API_KEY`,
  `EMBEDDING_*`. `LIVE_PUBLICATION_GATE_STATE` defaults `BLOCKED`.

## 3. Live state right now

- `docker compose -f compose.production.yaml ps` → **no containers running**.
- `pgrep cloudflared` → **no tunnel process running**.
- `.env` still carries two dead quick-tunnel origins (commented-known-stale per brief G013):
  - `CONSOLE_PUBLIC_ORIGIN=https://tribunal-contrast-minerals-managed.trycloudflare.com`
  - `STAGE_PUBLIC_ORIGIN=https://resolve-reform-retired-zshops.trycloudflare.com`
  - `curl --max-time 8` to both → `Could not resolve host` (curl 6, 000). Tunnels are gone;
    fresh `cloudflared tunnel --url` runs are required before any Vercel env can point at a
    live backend.
- `.env` also sets `NEXT_PUBLIC_STAGE_ORIGIN`, `STAGE_ORIGIN`, `CONSOLE_ORIGIN` to the same dead
  hosts; `CONSOLE_PRIVATE_API_ORIGIN=http://private-backend:3001` (Compose-internal only — a
  Vercel deploy needs the tunneled HTTPS private-API origin instead).

## 4. What Gate F3 needs that does not exist yet

1. `apps/stage/vercel.json` (or repo-root equivalent): SPA fallback + `/v1/*` external rewrite to
   the public gateway origin.
2. `bunx vercel link` for two new projects (console root `apps/console`, stage root `apps/stage`).
3. Fresh Cloudflare quick tunnels over a running `compose.production.yaml` stack; write the
   resulting origins into Vercel env (`CONSOLE_PRIVATE_API_ORIGIN` HTTPS tunnel → private-backend
   edge that denies `/internal/*`, per the Caddyfile pattern; `STAGE_ORIGIN`/
   `NEXT_PUBLIC_STAGE_ORIGIN` → stage Vercel URL; backend `.env` `CONSOLE_PUBLIC_ORIGIN`/
   `STAGE_PUBLIC_ORIGIN` → the two Vercel URLs).
4. Seed sample account + sample deck (`CONTROLLER_*` envs already provision the account path).
5. Smoke: `curl -i` health on both Vercel origins + presenter→audience flow.

## Files changed

- `.omo/evidence/ulw/01a0e2fe-ce33-7873-86ef-19857dd00fc5/G006/wave-c/deploy-surface.md` (this file, new).

## Plan task closed

Records the deploy surface for the `G-D`/G002 deploy goal and plan F3/F7 verification rows; no
plan code task is touched.

## Verification outputs (verbatim)

```
$ find . -name 'vercel*.json' -not -path './node_modules/*'; find . -name '.vercel' -not -path './node_modules/*'
(no output)
$ bunx vercel --version
Vercel CLI 60.1.3
$ bunx vercel whoami
Vercel CLI 60.1.3 (Node.js 26.7.0)
stevenahhh
$ bunx vercel project ls
Fetching projects in gahn
> No projects found under gahn
$ cat /Users/gahn/projects/99-aibootcamp-vibecoding/.vercel/project.json
{"projectId":"prj_Vu9umfxwLrKb5qVuCJIe9tBAHCOL","orgId":"team_xxLhxtjunho7MVUEbXICGVmC","projectName":"projectnmbd"}
$ docker compose -f compose.production.yaml ps
NAME      IMAGE     COMMAND   SERVICE   CREATED   STATUS    PORTS
$ pgrep -fl cloudflared
(no output)
$ curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' --max-time 8 https://resolve-reform-retired-zshops.trycloudflare.com/health
curl: (6) Could not resolve host: resolve-reform-retired-zshops.trycloudflare.com
000 0.009449
$ curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' --max-time 8 https://tribunal-contrast-minerals-managed.trycloudflare.com/
curl: (6) Could not resolve host: tribunal-contrast-minerals-managed.trycloudflare.com
000 0.018812
$ grep -niE 'deploy|vercel' .github/workflows/ci.yml
(no output)
$ git rev-parse --short HEAD
c4bb6ae
```

Verdict: **PASS** — report written; no infra modified.

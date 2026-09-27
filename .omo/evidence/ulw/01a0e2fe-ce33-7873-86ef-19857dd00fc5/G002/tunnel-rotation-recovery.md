# Rotation and redeploy recovery receipt

2026-09-27. The prior backend and Stage quick-tunnel hostnames
(`tribunal-contrast-minerals-managed` and `resolve-reform-retired-zshops`)
failed DNS lookup (`curl` status 000). This was an actual tunnel loss, not
a hypothetical rotation.

1. Started persistent `cloudflared tunnel --url http://127.0.0.1:3001`
   and `:3002` sessions. Checked each assigned hostname by `/health`:
   `penetration-replacement-fails-senior.trycloudflare.com` identifies
   `private-backend`, `surround-brand-metals-soap.trycloudflare.com`
   identifies `projection-gateway`.
2. Replaced public Console and Stage origins in ignored `.env` with
   their `impromptu-rev2-*.vercel.app` production aliases. The first
   `docker compose config` check showed inherited exported shell variables
   still pointing at the dead tunnels; overriding all five public-origin
   variables at the Compose command boundary produced the correct
   `CONSOLE_ORIGIN` and `STAGE_ORIGIN` in the rendered configuration.
3. Rebuilt private-backend and projection-gateway images; reran the
   migration initializer and recreated just those services without
   deleting Postgres or model volumes. Container `printenv` confirmed
   `CONSOLE_ORIGIN=https://impromptu-rev2-console.vercel.app` and
   `STAGE_ORIGIN=https://impromptu-rev2-stage.vercel.app`. Both services
   became healthy.
4. Set the Vercel Console backend and deck-asset tunnel origins and
   `NEXT_PUBLIC_STAGE_ORIGIN`; deployed Stage and Console from the
   monorepo root. The first app-directory deployments failed because
   the remote configured root `apps/{stage,console}` was absent from
   that upload; full-root deployments both finished `Ready` and
   acquired the two production aliases.
5. Fresh external fetches after recovery: backend `/health` 200,
   gateway `/health` 200, Console `/` 200, Stage `/` 200.
   An authenticated sign-in through the Console alias returned 201,
   and a seven-slide Stage snapshot after owner approval returned 200
   on the Stage alias (see `sample-deck-flow.md`).

The quick-tunnel hostnames and the deployed Stage rewrite are ephemeral.
A future tunnel rotation requires updating the destination in
`apps/stage/vercel.json`, the two Console project origins, rebuilding or
recreating backend/gateway if public origins change, and redeploying both
PWAs before repeating sign-in and Stage snapshot checks. This receipt
demonstrates recovery now, not guaranteed future availability.

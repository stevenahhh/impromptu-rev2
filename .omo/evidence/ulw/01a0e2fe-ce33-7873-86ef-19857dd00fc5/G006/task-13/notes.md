# Task 13/32 — Independent-browser Stage invitation consumption

## Mechanism implemented (apps/stage only)

- `src/landing-page.tsx` reads `#invite=<opaque>` exactly once during the initial render
  (`useState` initializer), validates it against the public `DisplayInvitationTokenSchema`, and
  scrubs the fragment in the first effect via `history.replaceState` — the token thereafter lives
  only in component state, never in the DOM, storage, cookies, event payloads, or history.
- With no `window.opener` and a valid token, the page POSTs a single `/v1/display-joins` with
  `invitationToken` in the JSON body (never the URL), then shows the pending state with the
  display ID and fingerprint the presenter will approve. It never claims a display session and
  never navigates until `POST /v1/display-session` succeeds — which the gateway only allows after
  the owner's bind gesture. Join expiry ends the wait with the honest expired state.
- Gateway rejections map to public states: 410 → expired, structured rejections
  (INVITATION_UNKNOWN / INVITATION_CONSUMED / INVITATION_DECK_MISMATCH) → invalid link, and only
  unanswered requests get a retry button (the in-memory token is reused; the URL never is).
- A pending join promise is stored in a ref so StrictMode's double effect-mount cannot double
  consume the one-use token (proven by a StrictMode test asserting exactly one join).
- The opener-led flow is untouched: an opener + invite still uses the console handshake and
  merely scrubs the fragment (regression test added).
- `stage-client.ts`: `createJoin` gained an optional `invitationToken` param; `DisplayJoinError`
  carries the gateway's public `status`/`reason`; `/v1/display-joins`, `/v1/display-session` and
  `/v1/stage-applied` pin `referrerPolicy: "same-origin"` so the page-wide `no-referrer` policy
  cannot break the gateway's exact Origin+Referer mutation check.
- Headers: `index.html` ships `<meta name="referrer" content="no-referrer">`;
  `vite.config.ts` adds a plugin that overrides dev/preview document headers and rewrites the
  generated `_headers` global rule to `Referrer-Policy: no-referrer` plus `Cache-Control:
  no-store` on document routes (`/`, `/index.html`, `/display/*`); the nginx `location =
  /index.html` fallback block in `Dockerfile` and `vercel.json` headers carry the same policy.
  Hashed assets stay cacheable.

## Verification

- `NODE_ENV=test bun test apps/stage/src` → 52 pass, 0 fail, zero React act warnings
  (the three "DisplayPage update not wrapped in act" warnings task-2 reported were the
  bounded-recovery test resolving deferred snapshots outside `act`; fixed by resolving and
  awaiting the applied event inside one act scope).
- `bun run typecheck` clean; `bun run lint` clean (one unrelated pre-existing gitignored
  `apps/console/.vercel/project.json` dotfile was reformatted so the repo-wide gate passes).
- `NODE_ENV=production bun run --cwd apps/stage build` clean; `dist/_headers` verified to carry
  all required security headers plus the new policies.
- Real Chromium against the real production bundle + real `createProjectionGatewayHandler`
  (`browser-check.mts`): bare URL inert with no join request; invited URL sends exactly one join
  POST with the token in-body, a same-origin Referer, and no fragment; pending identity matches
  the owner-facing pending view; after an internal bind the page navigates to `/display/…`, the
  audience cookie is set only then, and the slide renders READY. Replayed token → 409/invalid
  state; token issued then expired via injected clock → 410/expired state. `origin=<none>` in
  the log is Playwright not exposing Origin to request observers; the gateway's 201 is itself
  the exact-match proof (validMutationOrigin 403s otherwise).
- `bun run check:browser` fails only on `apps/console/.next` (a stale Sep-27 artifact missing
  STS in its routes manifest) — pre-existing, unrelated to this change.

## Evidence files

- `waiting.png` — pending state with display ID + fingerprint.
- `approved.png` — slide surface after presenter approval.
- `expired.png` — expired-link state. `replayed.png` — invalid-link state. `bare.png` — inert.
- `network-redacted.log` — wire log (token-bearing values redacted; zero `dinv_` occurrences).
- `browser-check.mts` — the runnable harness. `cleanup.txt` — process teardown record.

# G004 — Design-system / front-end visual sweep

Owns plan tasks 26–30, 33, 34, 38 (visual layer only) plus the steered Stage asset-failure fix.
Worktree: `/Users/gahn/.omo/wt/t9e8e9f581e/m`. No commits made; `apply:false` honored — this is
the isolation patch + evidence.

## Dev stack used for all screenshots (own ports, demo stack untouched)

- postgres: `g004-pg` container, `127.0.0.1:55432` (tmpfs, disposable; migrated via `infra/migrate.sh`)
- private-backend: `127.0.0.1:3101` (`logs/backend.log`)
- projection-gateway: `127.0.0.1:3102` (`logs/gateway.log`)
- console `next dev`: `:4180` (`logs/console.log`) — **must launch with `env -u NODE_ENV`**: an
  exported `NODE_ENV=production` makes Next dev throw `EvalError: Code generation from strings
  disallowed` on every page.
- stage `vite dev`: `:4181` (`logs/stage.log`)
- Account `localdemo` / `demo-2026-password`; deck `tests/fixtures/custom-deck-upload/custom-static-deck.pdf`.

Note: `bun run build` writes `apps/console/.next/` in place and corrupts a running dev server
(`Cannot find module './187.js'` → 500s on all routes). Restart `next dev` after any build.

## Defects found and fixed (in scope)

| # | Defect | Fix | Evidence |
|---|--------|-----|----------|
| 1 | Stage reported `READY` over a fully blank screen when slide bytes failed to load or verify (G006/task-2 `asset-failure.png`). | `StaticSlide` gains `onFailure` (img `onError` + SVG verify-failure catch, fires once, never auto-retried); `RenderedSlidePlayer` forwards `onFailure` from its last-resort fallback `<img>`; `display-page.tsx` tracks the failing occurrence as `{publicSlideKey}:{occurrenceSeq}` and swaps to a truthful claim — `copy.slideUnavailable` — with `data-audience-readiness="SLIDE_FAILED"`. Next occurrence remounts the player and clears the state. Unverified bytes are never painted. | `shots/stage-slide-failed-{desktop,mobile}.png` (mobile twin for task-2's `asset-failure-mobile.png`); regression test in `App.test.tsx` (`truthful slide failure`) |
| 2 | Stage had no `en` catalog and no locale mechanism; all copy hardcoded from `ko.json`. | New `stage-i18n.ts` (`resolveStageLocale`: `?lang=` wins → `navigator.languages` → `ko` default; `StageCopyProvider`/`useStageCopy`/`useStageLocale`); `en.json` created, `ko.json` completed (`pageTitle`, `slideUnavailable`, `placementExtend/Duplicate/Single`); `stage-routes.tsx` resolves once at mount so `?lang=` survives SPA navigation to `/display/:id`, sets `document.documentElement.lang` + `document.title`; landing/display/topology copy now flows through context. Dead keys removed (`enterFullscreen` etc.). | `shots/stage-landing-{desktop,mobile,present}-{ko,en}*.{png}`; `locale-parity.test.ts`; `audience language` tests in `App.test.tsx` |
| 3 | Evidence card `INTERNAL` badge used `success` tone — implies "verified/approved" to a presenter. | `evidence-card.tsx`: INTERNAL → `neutral`, EXTERNAL → `warning` (externally-sourced is the riskier claim to flag). | `shots/console-report-*`, `console-cockpit-*` |
| 4 | `live-publication-page.tsx` dead code: route renders `LivePublicationInterstitial`; page + 13 locale keys unreachable. | File deleted; dead keys stripped from both console locale JSONs (`liveApprovalLead` kept only where referenced — removed too). `locale-parity` test enforces ko/en parity. | `shots/console-interstitial-ko-desktop.png` |
| 5 | Upload dropzone hint `uploadSelect` orphaned in bottom status line, away from the file affordance; rail `console-status-line` force-truncated sentences via nowrap. | `deck-upload-panel.tsx`: hint moved into the dropzone as guidance `<p>`; status line shows `message` only. `console.css`: `.console-cockpit__side .console-status-line` wraps (`text-align:start; white-space:normal`) — mic status with retry control now readable. | `shots/console-upload-*`, `shots/console-cockpit-*` |
| 6 | At 1024×768 the stacked cockpit pushed the transport strip below the fold (controls measured 524–758px; rail overflows page scroll). The `--console-presenting-preview-cap` only applied while PRESENTING. | `console.css`: new `--console-stacked-preview-cap` (viewport minus app bar, heading row, transport budget) applied to `.console-preview__frame` at stacked widths in **every** phase; slide letterboxes via `object-fit: contain`. Post-fix: controls end at 758px < 768px. | `shots/console-cockpit-ko-present.png` (before: controls below fold) |
| 7 | Mobile workspace h1 truncated mid-word (`Presentaion prep…`) because `--presenting` modifier ellipsizes for desktop compaction. | Stacked media query: `overflow:visible; text-overflow:clip; white-space:normal` on the workspace h1. | `shots/console-cockpit-en-mobile.png` |
| 8 | Stage bare-notice copy too small for a projector/room-read surface. | `.stage-console-only p` → `--text-stage-display`, `--font-display`, centered, `--size-stage-copy` max-width. | `shots/stage-landing-desktop-ko-auto.png` |

## Constraints honored

- Token-driven only — every new rule uses `--text-*`/`--space-*`/`--size-*`/`--color-*`/`--font-*`;
  the one arithmetic is the `calc()` composing existing tokens.
- Stage remains chrome-free: no buttons, no status prose on the audience surface; locale comes
  from `?lang=` + browser language, not a visible picker. Placement outcomes stay screen-reader-only.
- No edits to `packages/contracts`, services, migrations, Vercel config, or other agents' evidence.
- `.vercel/project.json` (x2, gitignored, another lane's deploy artifacts): formatted in place so
  `biome check .` passes; content unchanged.
- `.gitignore` (+`.vercel/`) and `.omo/boulder.json` diffs in this worktree are **not mine**
  (harness/deploy lane) — left alone.

## Verification (exact exits)

| Command | Result |
|---|---|
| `NODE_ENV=test bun test --cwd apps/stage` | **50 pass / 0 fail** (incl. new `audience language` ×2, `truthful slide failure`, locale parity) |
| `NODE_ENV=test bun test --cwd apps/console` | **219 pass / 1 fail** — `private-api-proxy > early upstream rejection of a large upload body` fails **identically on the unmodified main checkout** (221/1 there) → pre-existing, not mine; passes when the file is run alone |
| `NODE_ENV=test bun test packages/ui` (from repo root) | 20 pass / 0 fail |
| `bun run typecheck` | exit 0 (all four tsc passes; fixed `display-page.tsx` strict-undefined on `currentSlide`) |
| `bun run lint` (`biome check .`) | exit 0 — 519 files clean |
| `bun run build` | exit 0 (ui + console Next build + stage vite build) |

## Scoped file list

**Stage:** `stage-i18n.ts` (new), `locales/en.json` (new), `locales/ko.json`, `locale-parity.test.ts`
(new), `stage-routes.tsx`, `landing-page.tsx`, `display-page.tsx`, `slide-view.tsx`,
`rendered-slide-player.tsx`, `use-screen-topology.ts`, `windows-topology.ts`,
`windows-topology.test.ts`, `stage.css`, `App.test.tsx`.

**Console:** `console.css`, `deck-upload-panel.tsx`, `evidence-card.tsx`,
`live-publication-page.tsx` (deleted), `locales/en.json`, `locales/ko.json`.

**Evidence helpers (not shipped):** `G004/shots.mjs` (Playwright harness), `G004/shots/` (47 PNGs),
`G004/logs/`.

## Findings handed off / not in scope

- **Hard navigation loses auth** — `RequireAuth` reads in-memory session; deep link to
  `/live-publication` or any authed route lands on sign-in. Session restore is task 37's lane;
  interstitial verified via in-app popstate navigation.
- **POST `/v1/account-sessions` throttles** (429 after ~4 rapid sign-ins) — harness retries
  15s; product-correct, noted for e2e authors.
- **Hydration mismatch warning** on sign-in page SSR (attribute mismatch, pre-existing; visible
  in `logs/console.log` console errors) — cosmetic dev warning, not introduced here.
- **`LivePublicationInterstitial` carries its own bilingual literals** in `console-routes.tsx`
  (comment says locale files owned elsewhere) — left as-is; recommend folding into the catalog
  when the i18n owner lands `en.json` governance.
- **Recommendation pipeline `ABSTAIN:MODEL_FAILURE`** in dev (inference endpoint is a stub URL);
  UI handles the abstain state correctly — `shots/console-cockpit-*` show truthful empty coaching.
- Mobile deck-upload page shows the full dropzone (fine); `data-upload-dropzone` is reachable at
  375px without scroll.

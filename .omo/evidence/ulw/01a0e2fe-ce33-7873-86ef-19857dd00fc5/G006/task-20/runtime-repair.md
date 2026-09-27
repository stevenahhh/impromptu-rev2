# Task 20 — Browser-runtime verifier repair (current Console + Stage surfaces)

Date: 2026-09-27. Host: darwin arm64 (Apple M5 Pro), node v26.7.0, bun 1.4.2, Playwright
Chromium (ms-playwright chromium-1234). `.env` at run time: `CHROME_EXECUTABLE_PATH=` (empty),
`BROWSER_HEADED=false`, `BROWSER_RUNTIME_RETAIN_ARTIFACTS=false`,
`NEXT_PUBLIC_STAGE_ORIGIN=https://impromptu-rev2-stage.vercel.app`,
`CONSOLE_PRIVATE_API_ORIGIN=http://private-backend:3001`.

## Failure reproduced first

`bun run check:browser-runtime` → **exit 1** (`reproduce.log`):

```
Error: Chrome executable not found at
    at withBrowserRuntimeWorkspace.retainArtifacts (scripts/verify-browser-runtime.ts:1136)
```

Empty-string `CHROME_EXECUTABLE_PATH` defeated the `??` fallback; after that fix the next two
layered failures were (a) focus-order divergence caused by a missing scroll-container model, and
(b) `.stage-claim` measured mid `ui-reveal` animation — both fixed in the checker, not the app.

## What changed (scripts/tests only)

### `scripts/verify-browser-runtime.ts`

- `CHROME_EXECUTABLE_PATH=""` now falls back to `chromium.executablePath()` (empty string is
  present-in-env, so `??` never fired).
- `verifyStageLayouts`: critical selectors now match the slide-only DOM
  (`main.stage-console-only` for the opener-less landing; `[data-audience-readiness]`,
  `.stage-display__content`, `.stage-claim` for `/display/rehearsal`), and `removed` selectors
  assert the deleted chrome stays deleted (`[data-stage-fullscreen]`, `[data-stage-placement]`,
  `.stage-display__bar`, `.stage-display__actions`, `.stage-evidence`,
  `[data-stage-chrome='visible']`). Critical selectors now fail when missing (previously
  vacuous). The fullscreen enter/exit block is deleted; in its place the verifier asserts the
  published `impromptu:target-screen-placement` outcome (valid status, `privatePixelCount === 0`)
  plus a non-empty assistive placement announcement — per plan task 20, real fullscreen/placement
  is a physical F3 check, not a headless one.
- `assertStageFitsViewport`: waits for `document.getAnimations().finished` (bounded 5 s) before
  measuring, so the 520 ms `ui-reveal` translateY is not read as a permanent clip.
- Console coverage added without touching the Vite `surfaces` pipeline (the Console is Next.js):
  `bun run build` in `apps/console` (gitignored `.next`), `next start` with
  `CONSOLE_PRIVATE_API_ORIGIN` pointed at an in-process fixture backend serving only
  `POST /v1/account-sessions` and `GET /v1/presentation-sessions/ps_a11y/report` (everything else
  404s so stray private fetches fail loudly). Auth goes through the real form and the real
  `/v1/[...path]` route handler; in-app navigation uses `pushState` + `popstate` because sessions
  are in-memory and `RequireAuth` bounces fresh loads.
- `accessibilityRoutes` now covers `console/sign-in`, `console/workspace` (`/`),
  `console/session`, `console/report` (`/reports/ps_a11y`, FINALIZED fixture → real
  `PresentationReport` + `QaDefensePanel`), `stage/landing`, `stage/display`. Each route carries
  exact landmark expectations (`main`/`h1`/`nav` counts; the deliberately inert Stage landing
  asserts `h1: 0`) and a per-route forced-colors target list (`null` on chrome-free Stage
  surfaces instead of vacuously failing).
- `assertKeyboardFocusOrder` now models Chromium's real tab order: overflowing `auto`/`scroll`
  containers are tab stops (the report's `.console-stack` scroller sits between the header and
  the Q&A button); `overflow:hidden` is correctly excluded.

### `tests/e2e/windows-topology.harness.ts`

- Same empty-`CHROME_EXECUTABLE_PATH` fallback.
- `enterFullscreen`/`exitFullscreen` and the `popup-blocked` + `fullscreen-exit` fault
  rehearsals removed (no Stage fullscreen control exists); placement now reads the mount-time
  `impromptu:target-screen-placement` event for every mode — `MANUAL_FALLBACK` verifies the
  assistive announcement instead of the removed `[data-manual-placement-mode]`/`[data-stage-placement]`
  DOM. Rehearsals now carry 6 faults (4 simulated + 2 real: `browser-refresh`, `projection-drop`).
- `privateSurfaceVocabulary` updated to current Console copy (stale strings like "One-time
  sign-in code"/"Private workspace" removed; current strings incl. Korean sign-in/upload/report
  copy added; strings shared with Stage copy such as "발표자 화면" deliberately excluded).
- Event buffer records `impromptu:target-screen-placement`/`-recovery`; fullscreen window events
  dropped.

### `scripts/verify-wp4-topology-e2e.ts`, `tests/e2e/windows-topology.test.ts`

- Contract updated: 6 faults/rehearsal (18 recoveries, 6 real, 12 simulated per mode);
  `manualPlacementFallback` is `VERIFIED` for all modes on this headless single-screen host
  (placement is attempted on mount in every mode).

## Verification (exact commands and exits)

| Command | Exit | Evidence |
|---|---|---|
| `bun run check:browser-runtime` (before) | **1** — `Chrome executable not found at ` | `reproduce.log` |
| `bun run check:browser-runtime` (after) | **0** — "Chrome runtime verified; temporary artifacts cleaned." | `runtime.log` |
| `BROWSER_RUNTIME_RETAIN_ARTIFACTS=true bun run check:browser-runtime` | **0** — artifacts at `artifacts/browser-runtime-zVvKRg/` | `runtime.log`, PNGs |
| `bun test tests/e2e/windows-topology.test.ts` | **0** — 1 pass, 56 expects, 13.9 s | `e2e-topology.log` |
| `bun run lint` (`biome check .`) | **0** — 515 files | this session |
| `bun run typecheck` (root + ui + console + stage `tsc --noEmit`) | **0** | this session |

Passing gate output covers: stage Vite build, `next build` of Console, dev-server
`frame-ancestors 'none'`, full SW update lifecycle (defer → operator/session-end activation →
cold restart cohort pin), offline shell install + foreign-cache canary rejection, cross-origin
iframe rejection, all six a11y routes (min contrast 5.49:1), reduced-motion ≤1 ms, slide-only
layouts at 1440x900 / 768x900 / 320x800 / 200%-equivalent with removed-chrome absence asserted,
published placement outcome, and nonblank cold-offline restart.

## Artifacts

- Screenshots (this dir): `a11y-console-sign-in.png`, `a11y-console-report.png`,
  `stage-display-1440x900.png`, `stage-placement-outcome.png`. Full set of 20 PNGs retained at
  `artifacts/browser-runtime-zVvKRg/` (gitignored). `artifacts/wp4-topology/` holds the e2e
  manifest + per-rehearsal DOM/screenshot/JSON with checksums.
- A11y contrast detail is in `runtime.log` (per-route scanned text containers + minimum ratios).

## Cleanup

- Verifier workspace/artifacts: `mkdtemp` under `$TMPDIR`, removed in `finally`
  (`retainArtifacts=false`); the retained-artifacts run intentionally leaves
  `artifacts/browser-runtime-zVvKRg/` (gitignored).
- Console `.next`/`dist` builds: gitignored build output, same convention as the existing
  topology harness.
- No verifier `next`/vite/bun/chrome processes left running (checked `pgrep`); fixture backend
  and preview origins close via the cleanup stack.
- No app source, docs, migrations, product authority, `.omo/boulder`, or git staging touched.
  Files changed: `scripts/verify-browser-runtime.ts`, `scripts/verify-wp4-topology-e2e.ts`,
  `tests/e2e/windows-topology.harness.ts`, `tests/e2e/windows-topology.test.ts`.
  Pre-existing unrelated dirty files from sibling tasks were left alone.

## Explicitly NOT claimed

- Physical Windows 11 venue (real Chrome/Edge, Extend/Duplicate, projector, EDID, F11/Esc,
  screen readers, captive portal) remains unverified — headless macOS Chromium only observed
  `MANUAL_FALLBACK` placement; `TARGET_PLACED` requires hardware (F3).
- Console offline/update-lifecycle and CSP-header checks remain Stage-only: the Next.js Console
  has no `_headers`/`sw.js?cohort` contract of the Vite kind, so it is intentionally outside the
  `surfaces` pipeline.
- "Teammate question" is not a standalone route in the current SPA; its reachable surface is the
  `QaDefensePanel` inside `/reports/:id`, which is exercised on the FINALIZED fixture.

# Task 5 — Release guidance & browser-runtime coverage inventory (baseline, no writes)

Date: 2026-09-27. Host: darwin arm64 (Apple M5 Pro), node v26.7.0, bun 1.4.2.
Plan task: `.omo/plans/impromptu-ideal-experience.md` task 5 — "Inventory release guidance and
browser-runtime coverage against the live UI" (Closes: GAP-16 baseline, GAP-7 release-input
inventory; Wave A, no writes; Commit: N).

## Commands run (once each, stdout archived)

| Command | Exit | Log |
|---|---|---|
| `bun run check:browser-boundary` | 0 — "Browser dependency boundary verified." | `browser-boundary.log` |
| `bun run check:browser-runtime` | **1** — fails before any UI assertion | `runtime.log` |

## Observed `check:browser-runtime` failure (exact)

```
Error: Chrome executable not found at
    at withBrowserRuntimeWorkspace.retainArtifacts (scripts/verify-browser-runtime.ts:1136)
    at file:///scripts/verify-browser-runtime.ts:1129
error: script "check:browser-runtime" exited with code 1
```

Root cause from source inspection: `.env:148` sets `CHROME_EXECUTABLE_PATH=` to an **empty
string**, and `bun run` sources `.env`. `scripts/verify-browser-runtime.ts:29` uses
`process.env.CHROME_EXECUTABLE_PATH ?? chromium.executablePath()` — `??` does not fall back on
empty string, so `chromeExecutable` is `""` and the pre-flight `existsSync` at :1136 throws
immediately. Playwright's Chromium IS installed at
`/Users/gahn/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/...`; an unset var would
have used it. A prior run recorded in `.omo/plans/zero-cost-deployment.md:179` instead reached the
UI and failed on "Stage landing rendered one `main` but no `h1`" — so after the env fix the next
expected failure point shifts to the Stage UI assertions below.

## Stale fullscreen assumptions (GAP-16 confirmed)

`apps/stage/src/App.test.tsx:361` asserts `document.querySelector("[data-stage-fullscreen]")` is
**null** — the control was deliberately removed (slide-only Stage; `display-page.tsx:91-124`
renders `.stage-display` + `.stage-display__content` with `data-audience-readiness`, no fullscreen
button, no `.stage-display__bar`/`__actions`). Yet:

| Consumer | Assumption | Status |
|---|---|---|
| `scripts/verify-browser-runtime.ts:677-710` | Waits for `[data-stage-fullscreen]` at `/display/rehearsal`, clicks it twice, asserts `document.fullscreenElement` transitions and screenshots `stage-physical-fullscreen.png` | **STALE — guaranteed timeout once Chrome launches** |
| `tests/e2e/windows-topology.harness.ts:340-352` | Clicks `[data-stage-fullscreen]` to restore fullscreen | **STALE** (matches the "one Stage fullscreen locator timeout" already in `zero-cost-deployment.md`) |
| `docs/runbooks/venue-failure-recovery.md:8,19,28-31` | Instructs operator to click "Enter fullscreen" / "Place on target screen" buttons that no longer exist | **STALE docs** |
| `docs/DEMO-SCOPE.md:17` | "Manual Stage placement and a Stage-local fullscreen click are canonical." | **STALE claim** — current Stage has neither control; placement runs automatically on mount (`display-page.tsx` comment) |
| `docs/final-manual-qa.md:65` | Physical-check list includes "fullscreen exit" — fine as a *physical* item, but maps to automated gates that no longer exercise it | Partially stale |

## Stale Stage layout selectors in the verifier

`verifyStageLayouts` (`scripts/verify-browser-runtime.ts:633-673`) requires critical elements that
no longer exist in Stage source:

- landing `/` expects `.ui-shell__header`, `.stage-welcome`, `.stage-join`, `.stage-join .ui-button`.
  Current `landing-page.tsx:124-143` renders `.stage-display`/`.stage-display__content`/`.stage-claim`
  (PAIRING path) or bare `main.stage-console-only` — **none** of the expected classes, and `.stage-welcome`/`.stage-join` appear nowhere in `apps/stage/src`.
- display `/display/rehearsal` expects `.stage-display__bar`, `.stage-display__actions`,
  `.stage-display__actions .ui-button`, `.stage-evidence`. `uploaded-slide-layout.test.tsx:116,138`
  asserts `.stage-evidence` and `.stage-display__bar` are **null**. Only `.stage-display__content`
  and `.stage-claim` still exist.

## Missing Console accessibility coverage (GAP-16 second half)

`docs/accessibility-matrix.md:7-15` promises Console `/sign-in`, `/`, `/session` plus Stage routes.
Actual `accessibilityRoutes` (`verify-browser-runtime.ts:716-721`) lists **Stage only** (`/`,
`/display/rehearsal`). `surfaces` (:83-93) likewise contains only the stage surface, so the Console
PWA is never even built/served by the verifier. The authenticated-Console fixture path
(`openAccessibilityRoute`, :745-762 — fake `/v1/account-sessions` response, `/sign-in` fill,
`Private workspace` nav, `/session` navigation) is dead code: no route sets `authenticated: true`.
Console strings it targets ("One-time sign-in code", "Enter private workspace", "Private
workspace", "Session setup", "Session controls") are not present in current `apps/console/src`
sources (grep returned no matches outside tests) — so even when routes are re-added, the fixture
copy is stale too.

## Stale card-publish checklist in release guidance

`docs/final-manual-qa.md` venue flow steps 5 ("Approve a curated recommendation… only the
declassified public card appears") and 6 ("Retract the visible card… replay rejected") still make
public card publication a mandatory physical gate. Current gateway: `POST /internal/cards` returns
**410 `stage_cards_disabled`** (`services/projection-gateway/src/http.ts:439-440`) and Stage is
slide-only (`data-stage-chrome="hidden"`, no card UI). Task 21 already flags steps 5/6 for rewrite
to slide/recovery checks; until then this checklist is stale.

## Exact check commands (documented surfaces)

- Full gate: `bun run check` = `check:repo` → `check:boundaries` → `build` → `check:browser`
  (`scripts/verify-browser-boundaries.ts`) → `check:browser-boundary`
  (`scripts/check-browser-dependencies.ts`) → `lint` → `typecheck` → `test` → `build` →
  `check:browser-runtime` (`package.json:36`). `check:browser-runtime` self-builds production Vite
  bundles for the surfaces it declares, so it is currently stage-only end to end.
- Release gates referenced by docs: `bun run test:aggregate` / `test:aggregate:10`
  (`scripts/run-wp10-release-gate.ts`), `bun run test:security`, `bun run test:e2e`,
  `bun run test:topology`, `bun run test:soak`.
- Env blockers for `check:browser-runtime` on this host: `.env:148` `CHROME_EXECUTABLE_PATH=`
  (empty string overrides Playwright autodetect — the observed exit 1). Also `.env`-sourced
  `BROWSER_HEADED=false`, `BROWSER_RUNTIME_RETAIN_ARTIFACTS=false`.

## Supported devices & physically unavailable inputs (source inspection only; no hardware claim)

- `docs/DEMO-SCOPE.md:11-15`: Windows 11, current stable Chrome and Edge, wired Extend, Duplicate
  with separate private controller, single-screen Stage fallback.
- `docs/final-manual-qa.md:52-58,63-70`: every venue row marked "Physical execution required —
  **Yes**"; the 10/10 aggregate record is explicitly an automated stand-in, not venue hardware.
- This host is macOS arm64 with headless Chromium; no Windows topology, projector, GPU/EDID,
  captive portal, clicker, screen reader, or physical fullscreen can be exercised here. No hardware
  claim is made or identifiable from source inspection.
- `docs/runbooks/venue-failure-recovery.md:35` records a **historical** 2026-08-14 real-Chrome run
  (72/72 fault recoveries) against the removed fullscreen UI — historical evidence, not replicable
  against the current DOM.

## Affected paths (read or run; nothing modified)

Read: `.omo/plans/impromptu-ideal-experience.md` (task 5, task 20, task 21, GAP-16),
`scripts/verify-browser-runtime.ts`, `scripts/browser-runtime-workspace.ts`,
`docs/accessibility-matrix.md`, `docs/final-manual-qa.md`, `docs/DEMO-SCOPE.md`,
`docs/runbooks/venue-failure-recovery.md`, `AGENTS.md`, `package.json`, `.env`,
`apps/stage/src/{landing-page,display-page}.tsx`, `apps/stage/src/App.test.tsx`,
`apps/stage/src/uploaded-slide-layout.test.tsx`, `services/projection-gateway/src/http.ts`,
`tests/e2e/windows-topology.harness.ts`.

Ran: `bun run check:browser-boundary` (exit 0), `bun run check:browser-runtime` (exit 1).

Cleanup: see `cleanup.txt` — verifier workspace is `mkdtemp` under `$TMPDIR` and removed in
`finally`; no residue found. Repo working tree was not modified by this task (pre-existing dirty
files unrelated, listed in cleanup.txt).

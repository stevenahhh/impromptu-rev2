# G006-repair / console-infra — report

Task: fix four verified console/shell defects (brief N5–N8). Verified against
`.omo/evidence/ulw/01a0e2fe-ce33-7873-86ef-19857dd00fc5/G006/audit-map.md` and the tree.
No `git add`/`git commit` performed.

## Brief-vs-ledger discrepancies found (checked, not assumed)

| Brief item | Finding |
|---|---|
| N6 "silent `location.assign` into a dead route" in `display-playback.ts:48-76` | No `location.assign` exists anywhere in the tree or in `git log -S` across all branches. The verified defect the ledger actually records is audit N6 / Deviation B: `/live-publication` silently `<Navigate>`s instead of the plan-28 "안내 후 복귀" interstitial. Fixed that. |
| N7 "`DeckPreviewProps` type" | Does not exist — zero hits in the tree, all git history, and other branches. The one real unreachable branch in scope: `approveDisplay` in `display-playback.ts` read a top-level `body.displayBindingEpoch`, but `/v1/display-bindings` answers only the strict `AudienceDisplaySession` DTO (`binding.displayBindingEpoch`, see `packages/contracts/src/public-protocol.ts:36-42` + `prepared-evidence.ts:720` returning `session.data`). Deleted the dead first arm. |
| N8 "consume the new `StagePairingStatus` type" | No such type exists in the tree, history, or plan/draft text. The pairing status type the workflow already uses is `AudienceScreenStatus`/`AudienceScreenOutcome`, already consumed by `audience-panel.tsx` and `playback-panel.tsx`. No unmatched extension point found; recorded as N/A rather than inventing an alias. |
| `cockpit-rail.test.tsx:201` / `playback-panel.test.tsx:170` reds (audit N8/N9 claimed product gaps) | Reproduced: both pass under a clean env (`NODE_ENV=test NEXT_PUBLIC_STAGE_ORIGIN=http://localhost:4174` → 13/13). The failures were ambient `.env:136` `NEXT_PUBLIC_STAGE_ORIGIN=<tunnel>`: join `MessageEvent`s dispatched from `localhost:4174` never matched the resolved stage origin. Made the tests consume `STAGE_ORIGIN` from `./stage-origin` instead of hardcoding localhost — deterministic under ambient and clean envs (same class of fix as audit N10). |

## Files changed

- `apps/console/src/stage-origin.ts` — new exported `resolveStageOrigin(runtime, buildTime)`: non-string, blank, non-URL, and non-http(s) candidates are rejected; the canonical `url.origin` is kept; dev-server fallback last. `STAGE_ORIGIN` now resolves through it, so `""` can never reach `stageUrl()`. **N5 closed.**
- `apps/console/src/app/(console)/layout.tsx` — emits the `window.__STAGE_ORIGIN` beforeInteractive script only when the env value is a non-blank string; previously emitted `""` unconditionally. **N5 closed.**
- `apps/console/src/console-routes.tsx` — `/live-publication` renders `LivePublicationInterstitial` (guide-and-return: heading, ko/en notice copy, `<Link to="/">` back to the workspace) instead of a silent `<Navigate>`. Copy is inline bilingual literals following the repo pattern (`live-publication-page.tsx:35-41`) because locale catalogs are another lane's exclusive scope; machine hook `data-live-publication-interstitial` added for tests. **N6 (audit Deviation B) closed.** The orphaned `live-publication-page.tsx`/`live-publication.ts`/`live-publication-client.test.ts` files remain on disk — deleting them is outside this lane's file scope; flagged for the orchestrator's commit grouping.
- `apps/console/src/display-playback.ts` — removed the unreachable top-level `displayBindingEpoch` arm; epoch is read only at `binding.displayBindingEpoch`, failing closed otherwise. **N7 (in-scope portion) closed.**
- `apps/console/src/cockpit-rail.test.tsx`, `apps/console/src/playback-panel.test.tsx` — join `MessageEvent`s now use the imported `STAGE_ORIGIN` instead of hardcoded `http://localhost:4174`; comment explains why (env-injected origin, once-per-process module resolution).
- New `apps/console/src/stage-origin.test.ts` — regression pin for N5: blank/whitespace/null runtime values lose to fallback, non-URL and `javascript:`/`file:` values rejected, canonicalization, `STAGE_ORIGIN` invariant, `stageUrl` encoding.
- New `apps/console/src/console-routes.test.tsx` — regression pin for N6: `/live-publication` renders the interstitial surface with a link whose `href` is `/` (machine-consumed values only).

## Verification (all run from repo root, ambient env unless noted)

- `bun run typecheck` — clean: four `tsc --noEmit` passes, no diagnostics (before and after edits).
- `env NODE_ENV=test bun test apps/console/src/cockpit-rail.test.tsx apps/console/src/debug-toggle-placement.test.tsx apps/console/src/playback-panel.test.tsx apps/console/src/presentation-report-page.test.tsx apps/console/src/stage-origin.test.ts apps/console/src/console-routes.test.tsx --timeout 15000` — **21 pass, 0 fail, 70 expect() calls** (ambient `.env` tunnel origin present; previously 3 of these failed ambiently).
- `bunx biome check` on all 8 touched/new files — clean after one `--write` format pass (biome reflowed two long lines).
- `env NODE_ENV=test bun test apps/console/src/audience-screen.test.tsx` — 15/15 pass (adjacent seam, sanity).

Pre-existing ambient caveat unchanged: `.env` NODE_ENV=production still breaks `React.act` if `NODE_ENV=test` is not passed (audit N13) — all runs above pass `NODE_ENV=test` explicitly per the audit's test matrix column.

## Not done / notes for orchestrator

- N8: N/A — artifact does not exist (see table).
- Orphaned live-publication files (live-publication-page.tsx, live-publication.ts, live-publication-client.test.ts) still on disk; `App.test.tsx` still has stale assertions for the old page (audit N7, owned by copy-locales lane — that task failed on a usage limit and may need re-dispatch).
- Interstitial copy is inline ko/en literals; if a later locale pass adds keys, swap the literals for `messages()` entries.
- Draft GAP-11 (`expectedDisplayBindingEpoch: "dbe_0"` hardcode in `approveDisplay`) confirmed real — gateway CAS rejects rebind once an epoch exists — but fixing it requires threading the current epoch through `ConsoleSessionClient.approveDisplay` in `console-client.ts`/`workspace-page.tsx`, outside this lane's scope. Flagged, not fixed.

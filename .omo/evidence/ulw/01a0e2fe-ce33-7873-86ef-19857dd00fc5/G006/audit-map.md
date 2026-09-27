# G006 — Master audit map: dirty tree vs impromptu-ideal-experience.md

Sources: `map-backend-shared.md`, `map-console-ui.md`, `map-locales-copy.md`, `test-matrix.md` (same dir), plan `.omo/plans/impromptu-ideal-experience.md` (tasks 1-41 + F1-F7), `git status --porcelain`.
Counts: **25 modified + 10 new test files + 2 new product files** (task brief said 23+7; actual tree is larger — all listed below). Test env caveat: ambient `NODE_ENV=production` (shell + `.env:143`) breaks `React.act`; all verdicts below use the `NODE_ENV=test` column of the test matrix.

## (a) File → plan task / defect map

### Modified files (25)

| File | Plan task(s) | State / defect |
|---|---|---|
| `apps/console/src/App.test.tsx` | 1, 16, 27, 28 QA; 12/32 pairing | 21/23 pass under NODE_ENV=test. Stale copy asserts `:488` (`준비된 근거`→`준비된 관련 자료`), `:852` (badge shape); missing `navigation "Private workspace"` landmark (`~:640`); 30s timeout in live-candidate test; 14 red in `Console-led audience screen pairing` (`:1627`,`:1993`) — feature unimplemented. |
| `app/(console)/layout.tsx` | 39 | Runtime `window.__STAGE_ORIGIN` inject; **Defect A**: `:24` emits `""` when env unset. |
| `audience-screen.ts` | 12, 32 (partial) | Closed-popup detection (2500ms poll + focus) only; no invitation/pending-check UI. Clean. |
| `coaching-display.tsx` | 34, 26 (partial) | Pre-opt-in folded row. Clean. |
| `cockpit-audio-capture.tsx` | 34 (partial) | `startCapture` retry on fresh gesture; DENIED/UNAVAILABLE attention state. Clean. |
| `console-routes.tsx` | 28 (partial) | `/live-publication` → silent `<Navigate>`; **Deviation B**: plan wants info-and-return interstitial; `live-publication-page.tsx` orphaned on disk. |
| `console.css` | 1/20 (retained UX R2), IS-3/Q12 | Dead-rule removal, preview aspect, sticky transport, prep drawer. Clean. |
| `debug-overlay.tsx` | UNPLANNED (nearest 38/IS-10) | Prod-gate `null`. Clean. |
| `evidence-card.tsx` | 29 (partial) | Drops rights/date/unavailable fields, hides absent rows, `data-evidence-badge`. INTERNAL still `success`-tone — 29 only partially served. |
| `locales/en.json`, `locales/ko.json` | 27, 28, 29 (partial) | `근거→관련 자료` sweep + `signInTitle` done; ~20 §3.2 terms unrenamed (see defects). |
| `presentation-report-text.ts` | 36 | +11 `reportQa*`/`qaSource*` keys; type relocated. Clean. |
| `presentation-report.tsx` | 36, 29 | `slides` map → human titles; additive `<ReportQaDefense>`. Clean. |
| `private-api-proxy.ts` | 39-adjacent / GAP-15 seam | Early upstream-rejection forwarding. Clean. |
| `private-api-proxy.test.ts` | same | **Test defect**: `:106` hardcodes default origin; fails when `CONSOLE_PRIVATE_API_ORIGIN` set (ambient 1/2, forced-origin 3/0). |
| `private-shell.tsx` | 28 | NavLink removed; `evidenceApproval` key now unused. Clean. |
| `session-client.test.ts` | 12/16/37 foundation | 21/0 pass. |
| `session-report-view.ts` | 36 | Optional `qaDefense` parse via new module; v1 safe. Clean. |
| `stage-origin.ts` | 39 | Runtime > build-time > localhost:4174; **Defect A**: `:14` accepts `""`. |
| `deck-upload.test.tsx` | 17/30 | 6/0 pass. |
| `compose.production.yaml` | 39 (partial) | `:176` `STAGE_ORIGIN` env for console service. Clean; rest of task 39 (compose config check, runbook, drift detect) absent. |
| `packages/contracts/.../private-reference-documents.ts` | 17/30 | `:23` adds `EMBEDDING_UNAVAILABLE` — **D3 dead enum** (no producer). |
| `services/.../http/responses.ts` | 17/30 | `:27` maps it → 503 — dead mapping (D3). |
| `services/.../reference-documents.ts` | 17/30 | Embed-fail degrades to EMPTY/ACCEPTED. **D1**: `:399-402` stale chunks survive degrade re-upload; **D2**: `:454-455` upload response reports INDEXED from extracted text, not `rows`; **D4**: `:370-385` outage swallowed, EMPTY overloads "no text" with "no embeddings". |
| `.omo/boulder.json` | out of scope | Orchestration metadata (paused hyperplan session). Not plan work. |

### New untracked files (12 product-relevant)

| File | Plan task(s) | State |
|---|---|---|
| `qa-defense-report.ts` | 36 | Closed view/parser for report Q&A section (ledger field names). |
| `report-qa-defense.tsx` | 36 | Renders Q&A defense; consumes `reportQa*` keys. |
| `cockpit-audio-capture.test.tsx` | 34 | 5/0 pass. |
| `cockpit-rail.test.tsx` | 29-33 | 3/5 pass; **fail `:201`** — post-start drawer lacks `.console-reference-documents` (rail refold unimplemented). |
| `debug-toggle-placement.test.tsx` | unplanned (38-adjacent) | 3/0 pass. |
| `evidence-card.test.tsx` | 29 | 4/0 pass. |
| `locale-parity.test.ts` | 38 | 1/0 pass; key-set only — §3.3 variable-parity missing (defect). |
| `playback-panel.test.tsx` | 32/33 | 2/3 pass; **fail `:170`** — dead-binding expiry emits no rebind/approval request. |
| `presentation-report-page.test.tsx` | 11/36 | 2/0 pass (route-level; PENDING auto-recovery not evidenced). |
| `presentation-report.test.tsx` | 36 | New suite for report rendering. |
| `session-report-view.test.ts` | 29/36 | Parser coverage. |
| `presenter-console.test.tsx` | 1/36-adjacent | Referenced by task 1 QA command. |

Non-product untracked, no plan row: `.omo/drafts|plans|ulw-*|evidence`, `docs/paper/` (personal academic papers), `.tmp-docx/` (docx tooling).

## (b) Tasks the tree claims to implement — verification state

| Task | Tree evidence | Verified? |
|---|---|---|
| 28 (retire public-approval nav) | routes+shell edits, locales | Partial — silent redirect, no interstitial; orphan file; `liveApproval*` keys remain. |
| 29 (context copy/provenance) | evidence-card, locales sweep, report text | Partial — INTERNAL `success` badge; raw `reason` renders via panel:67; ~20 terms left. |
| 34 (honest mic/coaching) | cockpit-audio-capture, coaching-display, `captureRetry` | Partial — mic retry done; answer-state taxonomy (§4.6) not in these diffs. |
| 36 (Q&A+report) | qa-defense-report.ts, report-qa-defense.tsx, session-report-view, report.tsx/text | Partial — additive v2 render + parser; PENDING recovery (11), tab IA (§4.8) absent. |
| 39 (deploy origin) | layout.tsx, stage-origin.ts, compose env | Partial + Defect A — no `docker compose config` check, runbook, drift detection. |
| 17/30 (readiness/degrade) | contracts enum, responses 503, reference-documents degrade | Partial + D1-D4 — degrade works but lies (INDEXED), leaks stale chunks, dead enum. |
| 12/32 (pairing) | audience-screen closed-popup watch; App.test pairing suite | Groundwork only — all 14 pairing tests red; no `/v1/display-invitations` client call. |
| 38 (parity) | locale-parity.test.ts | Partial — key-set only. |
| 27 (auth copy) | `signInTitle` only | Barely started. |
| 1 (baseline/GAP-1) | console.css retained work, presenter-console.test | Test harness exists; baseline evidence not produced. |

## (c) Not yet implemented

**Automatable (no external dependency):** 6,7 (invitation contract+authority), 8 (team grant+inbox+migration), 9 (STT deadline), 10 (FINAL decoupling), 11 (PENDING recovery), 13 (Stage invite consume), 14 (teammate UI), 15 (receipt/asset verify), 16 (state reset), 17/30 remainders (OCR warning, reason translation, cause-separated status), 18 (coaching aggregates), 20 (a11y validator), 21 (docs), 22 (E2E), 23 (integration), 24-26 (baselines/inventory/spec), 27 remainder, 28 remainder (interstitial, key/file cleanup), 29 remainder (~20 terms), 32 remainder, 33, 35, 37 (presentation list+migration), 38 remainder, 39 remainder, 40, 41, F1/F2/F4-F7.
**Venue/provider-blocked:** F3 + Q15 (physical Windows 11 + projector, 10 signed runs — hardware gate); task 19 cohort gate (automatable harness, needs approved provider account); task 39's live-deploy verification needs real deploy env; `.env`-injected `NODE_ENV=production` currently breaks every tsx test — fixable, but until then the whole frontend suite is unverifiable ambiently.

## (d) Suggested atomic commit grouping

Style per history (`feat(console):`, `fix(private-backend):`); shared contract+producer+consumer land together.

1. `fix(private-backend): degrade reference uploads when embeddings are unavailable` — contracts/private-reference-documents.ts, http/responses.ts, reference-documents.ts. **Must fix D1/D2 first** or ship as WIP-not-commit.
2. `fix(console): read the stage origin at runtime` — layout.tsx, stage-origin.ts, compose.production.yaml (+ fix for Defect A).
3. `fix(console): retire the disabled live-publication route` — console-routes.tsx, private-shell.tsx, locales (+liveApproval* cleanup).
4. `fix(console): separate customer copy from evidence contracts` — evidence-card.tsx, en/ko.json (29 hunks), App.test.tsx copy-assert updates.
5. `fix(console): keep mic retry and folded coaching honest` — cockpit-audio-capture.tsx, coaching-display.tsx + their tests.
6. `feat(console): render post-talk Q&A in the presentation report` — qa-defense-report.ts, report-qa-defense.tsx, session-report-view.ts, presentation-report{,-text}.tsx/ts + tests.
7. `feat(console): detect a closed presentation window` — audience-screen.ts (partial 12/32 groundwork).
8. `fix(console): hide the debug overlay in production` — debug-overlay.tsx, debug-toggle-placement.test.tsx (flag as unplanned scope).
9. `fix(console): forward early private-API rejections` — private-api-proxy.ts/.test.ts (+ env-stub fix).
10. `test(console): cover cockpit rail, playback binding, locale parity` — remaining new tests; **do not commit red** (cockpit-rail:201, playback-panel:170 need product work first).
`.omo/boulder.json`, `docs/paper/`, `.tmp-docx/` — never staged.

## (e) Defects needing new tasks (file:line + repro)

| # | Defect | Repro |
|---|---|---|
| N1 | `reference-documents.ts:399` — degrade re-upload skips chunk DELETE; stale vectors retrievable while row says EMPTY/0 | Upload with working embed; break embed; re-upload → chunks persist. |
| N2 | `reference-documents.ts:454-455` — upload response INDEXED/N from text, not `rows` | embed throws; upload → INDEXED; list → EMPTY. |
| N3 | `private-reference-documents.ts:23` + `responses.ts:27` + `reference-documents.ts:214` — dead `EMBEDDING_UNAVAILABLE` | No producer emits it; untested 503 path; raw enum would render verbatim. |
| N4 | `reference-documents.ts:370-385` — provider outage indistinguishable from empty file (no log, no cause) | embed rejects once → same EMPTY as whitespace file. |
| N5 | `layout.tsx:24` + `stage-origin.ts:14` — `""` runtime origin beats localhost fallback | Unset both env vars → `stageUrl("v1")` = `/?deck=v1`. |
| N6 | `console-routes.tsx` — silent redirect vs planned interstitial; `live-publication-page.tsx` orphaned | Visit `/live-publication` → no 안내 step. |
| N7 | `App.test.tsx:488,852` stale copy asserts; `:640s` missing nav landmark; live-candidate 30s timeout; 14 pairing reds (`:1627,:1993`) | `env NODE_ENV=test bun test App.test.tsx` → 21/23 + 2 errs. |
| N8 | `cockpit-rail.test.tsx:201` — post-start drawer missing `.console-reference-documents` (refold unimplemented) | test run → 2 fails. |
| N9 | `playback-panel.test.tsx:170` — dead-binding expiry emits no rebind request | test run → 1 fail. |
| N10 | `private-api-proxy.test.ts:106` — hardcoded origin; env-fragile | ambient `.env` origin → 2 fails. |
| N11 | `ko.json:2,5,7,14-17,22,44,45,49-63,71,77-93,101,119-135,139,141,149,153,165,176-185,193` (+en mirrors) — ~20 §3.2 terms unrenamed incl. 4/5 E12 items; §3.3 "not stored" claim still present | `grep -n "<term>" ko.json`. |
| N12 | `locale-parity.test.ts` — no variable/placeholder-set parity (§3.3) | inspect 9-line test. |
| N13 | Test env: `.env:143` `NODE_ENV=production` + shell export → `React.act` absent; all tsx suites red ambiently | `NODE_ENV=production bun test evidence-card.test.tsx`. Task-39 domain. |

## Verdict

The dirty tree partially serves plan tasks 17, 27, 28, 29, 30, 32, 34, 36, 38, 39 (plus task-1 UX-R2 retention and test-harness groundwork for 11/12/16/37); every remaining task — all of Wave A baselines (1-5 minus CSS retention), all of Wave B (6-11), most of Wave C (13-16, 18) and all of Wave D/F — is unimplemented, with only F3/Q15 and parts of 19/39 blocked on hardware, provider, or deploy environment. Defects needing new tasks are N1-N13 above: the backend degrade leaves stale chunks (reference-documents.ts:399) and a false INDEXED (:454-455), ships dead `EMBEDDING_UNAVAILABLE` contract (:23/:27/:214) and an uncategorized silent outage (:370-385); the runtime stage origin accepts `""` (layout.tsx:24/stage-origin.ts:14); task 28 landed a silent redirect instead of the planned interstitial; the test tree carries stale assertions (App.test.tsx:488,:852), three product-gap reds (cockpit-rail:201, playback-panel:170, the 14-test pairing block), one env-fragile test (private-api-proxy:106), and a repo-environment defect (`.env` NODE_ENV=production) that nullifies every tsx suite under ambient shell. Nothing in this tree is commit-ready as-is: commits 1, 2, 10 require defect fixes first, and task brief counts (23+7) understate the actual 25+12 footprint.

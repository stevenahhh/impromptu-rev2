# Task 1 — Console real-browser baseline (bounded PASS/FAIL)

Generated: 2026-09-27T19:36Z (browser run) · Agent: senpi-task st_01a0e3d4
Evidence root: `.omo/evidence/ulw/01a0e2fe-ce33-7873-86ef-19857dd00fc5/G006/task-1/`

## Surfaces under test

- Console served at `http://localhost:4473` (Next dev) from a `git archive HEAD` snapshot
  at `/tmp/t1-head` (HEAD `94fa31cfa12feb2d1a21246cd717ea46ab869aeb`).
- Stage at `http://localhost:4474` (vite dev) from the same HEAD snapshot.
- Task-owned services: private-backend `127.0.0.1:3401`, projection-gateway `127.0.0.1:3402`,
  task-owned Postgres container `impromptu-t1-pg` (migrations applied, RLS roles intact).
- Two task-owned Chromium (playwright-core 1.62.1, bundled chromium-1234) persistent profiles:
  `profiles/console` (presenter) and `profiles/stage` (independent device, no opener).

## Why the existing Compose stack was not used (exact blocker evidence)

The pre-existing healthy `impromptu-ulw-g003-demo-*` compose stack serves ports
3001/3002/4173/4174, but two properties make it unusable for a localhost Console baseline:

1. `CONSOLE_ORIGIN=https://impromptu-rev2-console.vercel.app` inside
   `impromptu-ulw-g003-demo-private-backend-1`; the exact-origin guard in
   `services/private-backend/src/http/origin-guard.ts` therefore rejects every browser
   mutation from `http://localhost:4173`. Probe: `POST /v1/account-sessions` with
   `Origin: http://localhost:4173` → `HTTP/1.1 403 {"error":"origin_forbidden"}`
   (recorded in `baseline.log` preamble and reproducible with curl).
2. Its console image (`impromptu/console:latest`, built 2026-09-27T22:00+09:00) predates
   HEAD: the container bundle still renders `reportFinalizeFailed:"리포트를 마무리하지
   못했습니다"` where HEAD's `apps/console/src/locales/ko.json` reads `"발표 결과를
   정리하지 못했어요. 발표가 계속 중이라면 '발표 종료'를 다시 눌러 주세요."`.

The working tree itself was being merged by a parallel session during capture (merge-conflict
markers observed transiently in `apps/console/src/workspace-page.tsx`, `display-playback.ts`,
`locales/*.json`), so the browser baseline runs against the HEAD snapshot, which is the only
coherent "current" tree. `git status --short`, dirty-path sha256s, and the diff stat at capture
time are in `git-baseline.txt` / `git-dirty-hashes.txt`. `bun test` below was run against the
working tree as specified; it passed on the post-merge state.

## Scenario ledger (see failures.json + baseline.log)

| Check | Verdict | Evidence |
|---|---|---|
| Sign-in (localdemo via `[data-sign-in-*]`) | PASS | `shots/01-sign-in-1440.png`, `02-workspace-upload-1440.png` |
| Upload 6-slide PPTX (`[data-deck-file-input]`) | PASS | `shots/03-cockpit-preparing-*.png` |
| Independent Stage `/?deck=<v>` (no opener) | PASS (inert by design, GAP-2 confirmed) | `shots/04-stage-independent-1440.png` — "발표자 화면에서 발표 화면을 열어 주세요. 이 페이지만 열면 시작되지 않아요." |
| Console-opened Stage popup → bound | PASS | `shots/04b-stage-popup-1440.png`, `04c-console-bound-1440.png`; popup `[data-audience-readiness]=READY` with rendered slide |
| Slide navigation (4× 다음 슬라이드, bound, PREPARING) | PASS | `shots/05-slide-5-preparing-1440.png`, `05b-stage-slide-5-1440.png` |
| Replace 6-slide deck with 3-slide PDF at index 4 | **FAIL (GAP-10 reproduced)** | `shots/06b-short-deck-cockpit-1440.png` — counter reads **"5 / 3"** and preview shows "슬라이드를 불러오지 못했어요." (`gap10-out-of-range-preview.png`) |
| Start on replaced deck while old binding retained | Defect observed (recorded as PASS of the probe): `POST /v1/playback/slide-set` → **409**, `발표 시작` silently inert | `shots/06c-stale-binding-409-1440.png`, `baseline.log` `http 409 …/v1/playback/slide-set` |
| Rebind new deck → start → PRESENTING | PASS | `shots/07-presenting-1440.png`, `07d-stage-presenting-1440.png` |
| C1 transport strip above fold at 1024x768 | **FAIL** | `shots/07b-presenting-1024.png` — `[data-transport-strip]` box y=639 h=154 → ends 25px below 768px fold; prev/next/end buttons unreachable without scroll |
| C5 preparation surfaces folded while PRESENTING | PASS | `[data-preparation-surfaces='COLLAPSED']` present, `[data-stage-open]` absent; `shots/07-presenting-1440.png` |
| Report PENDING surface | PARTIAL — end→report navigation works; finalization completed before first status read (~ms), so `data-report-status=PENDING` was never observed live | `shots/08-report-1440.png`; HEAD `report-page.tsx` shows a `data-report-retry` path exists for PENDING (GAP-14 hook present) |
| C3 report slide identifiers | **FAIL** | `data-report-slide-key` values are `slide_<64-hex>` (e.g. `slide_e8d26df1…`); visible titles are human-readable ("Custom static deck — slide 1"), so the raw key survives only in DOM attributes — `shots/08-report-1440.png` |
| Reload while authenticated | **FAIL** | `page.reload()` on `/reports/<id>` lands on `/sign-in` (no session restore at HEAD) — `shots/09-after-reload-1440.png` |
| Sign-out → register+sign-in account B | PASS | B sees clean upload surface, no A deck/cockpit — `shots/10-after-signout-1440.png`, `11-account-b-workspace-*.png` |
| Mic permission ungranted → failure affordance | PASS (attention style + `data-capture-retry` present) | visible in `03-cockpit-preparing-1440.png`, `07-presenting-1440.png` |

## UX Round 2 criteria (C1–C8) summary

- C1 transport-above-fold @1024x768: **FAIL** (see above).
- C2 badge contrast ≥4.5:1: **NOT DIRECTLY MEASURED** — success badge ("발표 화면 연결 확인")
  renders white-on-dark; computed pixel contrast not instrumented this pass.
- C3 report shows human slide identifiers: visible titles PASS; raw `slide_<hex>` remains in
  `data-report-slide-key` attributes (recorded FAIL on the strict criterion).
- C4 Q&A cards show question wording: **NOT EXERCISED** — Q&A requires the post-talk
  answer flow; the report rendered its Q&A section header only (no exchanges submitted).
- C5 prep controls hidden while presenting: PASS.
- C6 mic failure attention + retry: PASS (`data-capture-retry` present; headless lacks mic).
- C7 evidence badge single / no '정보 없음' rows: **NOT EXERCISED** — no recommendations were
  produced (evidence.recommend.error logged; chat/embedding external providers unreachable
  or rate-limited in this topology).
- C8 one-line upload prompt + Debug toggle outside cockpit: PASS — upload panel copy is a
  single line; Debug toggle renders bottom-right outside the cockpit rail in `02-*` shots.

## Test gate (VERIFY)

`NODE_ENV=test bun test apps/console/src/App.test.tsx apps/console/src/presenter-console.test.tsx`
→ **exit 0, 54 pass / 0 fail / 267 expect()** on the working tree (post-parallel-merge state).
Full output: `tests.log`. Note: tests inject mock clients; they do not stand in for the browser
results above — every verdict above is a real-browser observation.

## Non-blocking observations

- `GET /v1/presentations` returns **400** right after sign-in (presentation-library feature
  present in working tree; call shape rejected by backend `3401` — likely new-client vs
  HEAD-backend mismatch inside the mixed topology; recorded, not a UX failure for task-1 paths).
- `GET /v1/deck-assets/.../slide-1.svg` 404'd once right after long-deck upload (render still
  in flight); subsequent loads and the stage popup rendered all slides correctly.
- Stage independent page renders a clear inert message — GAP-2 baseline confirmed: a bare
  `?deck=` URL on a device with no opener never joins.
- `reload-session-restore` FAIL documents that HEAD lacks the `hydrateSession` restore that a
  parallel session was implementing mid-run (`auth-session.tsx` diff observed).

## Cleanup

See `cleanup.txt` — task-owned processes killed, ports 3401/3402/4473/4474 verified unbound,
`impromptu-t1-pg` container removed, `/tmp/t1-head` snapshot and browser profiles removed.
Pre-existing listeners (g003 compose forwards on 3001/3002/4173/4174, other worktrees' 31xx
services) were untouched throughout.

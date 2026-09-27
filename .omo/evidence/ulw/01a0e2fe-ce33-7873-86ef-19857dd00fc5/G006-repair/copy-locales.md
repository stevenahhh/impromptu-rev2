# G006 copy & locales — repair evidence (st_01a0e34b)

Date: 2026-09-28 · Lane: copy/locales · Scope: `apps/console/src/locales/*`, `locale-parity.test.ts`, copy-pinned tests, `session-report-view.ts` (declared but intentionally untouched — see §4.2), `apps/stage/src` copy surfaces, `packages/test-harness` DOM registration seam.

## 1. What shipped

### 1.1 Catalog rewrite (both locales, 194 keys each)
`apps/console/src/locales/{ko,en}.json` fully rewritten to the plan §3.2 terminology contract:

- **ko is 해요체** everywhere; **en is sentence-case**.
- Terminology applied verbatim from the table: `청중 화면 → 발표 화면`, `준비된 근거 → 관련 자료`, `비공개 발표 제어 → Impromptu에 로그인`, `비공개 워크스페이스 입장 → 로그인`, `워크스페이스 → 발표 준비` / `발표자 화면`, `코칭 지표 → 발표 도움말`, `발표 리포트 → 발표 결과`, `내부 근거 승인됨 → 업로드한 자료`, `권리 미확인 → 이용 조건 확인 필요`, `출처 URL → 원문 보기`.
- `evidenceApproval` block deleted (flow retired); `/live-publication` route now renders a guide-and-return interstitial (`liveApprovalLead`/`liveApprovalAction`/`liveApprovalReturn`).
- New keys added for surfaces the old catalog missed: `reportRetry` (sibling lane's PENDING retry control — parity preserved), `qaRecord{Start,Stop,Transcribing,Denied,Failed,Unavailable}` chip family, `referenceStoredUnindexed {total}/{unindexed}` placeholder pair (was a hardcoded English-shape count string).
- Placeholders rationalized: `{reason}`/`{count}` only where a real interpolation exists.

`apps/stage/src/locales/ko.json`: dead keys removed; "Impromptu 청중 화면" → "Impromptu 발표 화면" via `windows-topology.ts` literal rename.

### 1.2 Metadata / static copy (task 25/27 surfaces)
- `apps/console/src/app/(console)/layout.tsx`: title `Impromptu Presenter Console → Impromptu`; description rewritten without "private presentation workspace".
- `apps/console/public/manifest.webmanifest`: `name`/`short_name`/`description` → Impromptu, preparation copy.
- `apps/console/public/offline.html`: title/h1 `Impromptu Console offline → Impromptu offline`; body copy de-jargoned.
- `apps/stage/public/manifest.webmanifest`: `name` → `Impromptu 발표 화면`, `short_name` → `발표 화면`, description → `발표 슬라이드를 보여 주는 공개 화면입니다.`
- `apps/stage/index.html`: `<title>` → `Impromptu 발표 화면`.

## 2. Defect ledger → resolution map

| Defect | Where it lived | Resolution |
|---|---|---|
| **N4** — report hint referenced a dead route/feature | `reportLead` copy + `report-page.tsx` reads | `reportLead` rewritten to "Review your presentation time and question history." / "발표 시간과 질문 기록을 확인하세요."; the page itself was concurrently reworked by the report-repair lane (PENDING/FORBIDDEN + retry) — my contribution was the copy keys `reportPending`/`reportRetry`/`reportUnavailable`/`reportFinalized`/`reportFinalizing`/`reportFinalizeFailed`. |
| **N9** — stale assertion text pinned to old copy | `App.test.tsx` (44 tests), `deck-upload.test.tsx`, `evidence-card.test.tsx`, `cockpit-rail.test.tsx`, `playback-panel.test.tsx`, `presenter-console.test.tsx`, `windows-topology.test.ts`, `qa-defense-panel.test.tsx`, `spoken-question.test.tsx`, `presentation-report*.test.tsx`, `audience-screen.test.tsx`, `debug-*.test.*` | String assertions updated to renamed copy; nav-landmark test rewritten (nav intentionally removed); two `/live-publication` tests converted to **negative pins** asserting the interstitial renders and `readLiveCandidates`/`approveLiveCandidate` are never invoked. |
| **N10** — env-dependent `stageOrigin` literal | `App.test.tsx` | Hardcoded `http://localhost:4174` replaced with imported `STAGE_ORIGIN`; this was the real cause of the 14 pairing reds, not the DOM cascade. The old test also contained a 30 s `act` timeout whose residual act-queue corruption explained earlier cross-file cascades. |
| **N11** — banned jargon still user-visible | both locale files + inline literals | Full sweep: `근거`, `비공개 발표 제어`, `청중 화면`, raw backend enums, unverifiable privacy claims — **zero hits** in `ko.json`, `en.json`, `stage/ko.json`. Verified by `rg` scan of every audited term (see §3). |
| **N12** — parity test only compared key sets | `locale-parity.test.ts` | Hardened: exact key-set equality **plus per-key placeholder-set parity** plus non-blank values. Catches the `{reason}`/`{count}` drift class that was previously invisible. |

### 2.1 The DOM-cascade root cause (new finding, fixes the *test infra* half of N9/N13)
`proxyPrivateApi` binds `globalThis.fetch` at module init; each test file's `GlobalRegistrator.unregister()` restored whatever `fetch` descriptor it had captured — under multi-file eval ordering that could be a **closed** happy-dom window's `fetch`, detonating in any later file (`"The window is closed"`). Additionally, React's `scheduler` binds `globalThis.MessageChannel` at first render; happy-dom's channel posts through the window's task manager, so any mid-run window swap/closing deadened the commit path (empty `<div/>`, 15–25 s timeouts).

Resolution: `packages/test-harness/src/dom-globals.ts` exports `registerDom()`:
1. Registers once; **never unregisters** — the window stays alive and `globalThis.fetch`/`MessageChannel`/timers stay valid for the whole process.
2. Restores Bun's real platform globals (fetch family, streams, URLSearchParams, timers, `MessageChannel`/`MessagePort`, crypto, File/Blob/FormData) after registration, so DOM-simulated stand-ins can't leak into network-semantics tests.
3. Does a per-file state reset (`documentElement.lang`, `window.__STAGE_ORIGIN`, `opener`, storage, history) instead of swapping windows, preserving isolation without lifecycle hazards.

All 21 test files that previously did `register()/afterAll(unregister)` now call `registerDom()`.

## 3. Verification

| Check | Result |
|---|---|
| `bun run typecheck` (root + packages/ui + console + stage) | **PASS** (exit 0) |
| `bun run lint` (`biome check .`) | **PASS** (507 → 512 files, no findings) |
| `bun test apps/console/src` — all files except `presenter-console.test.tsx` | **188/0 fail** (1831 expects, 25 files, 442 ms) |
| `bun test apps/stage/src` | **40/0 fail** (223 expects) |
| `bun test apps/console/src` full aggregate | **83 pass / 111 fail** — see residual below |
| Banned-term scan (`rg` over `근거|비공개|청중 화면|리포트|워크스페이스|코칭 지표|색인|조각|권리|출처 URL` + en mirrors `workspace/evidence/private/report/approv/coaching/indexed/snapshot`) | **zero banned hits** in all three locale files; remaining en hits are inert key names (`evidenceSourceUrl`, `reportEvidence*`) or sanctioned terms (`Presenter view`, `Audience question`) |
| Locale parity | key parity 194/194; placeholder-set parity enforced by the hardened test |

### Residual — external, not this lane
`apps/console/src/presenter-console.test.tsx` ("end lands on the compiling summary and resolves to the real report on retry") times out at ~25 s **standalone**. It is a staged-but-not-in-HEAD worktree file (sibling lane WIP) awaiting `session-client.ts` work that hasn't landed (`readFinalizedReport`/`subscribeFinalizedReport` wiring for the PENDING-retry path; `session-client.ts` unchanged since Sep 2). Its `await summaryLanded` inside `act()` never resolves, and the test dies mid-`act`, corrupting React's process-global act-queue — every subsequent DOM render then produces an empty `<div/>`. That's the single source of the 111-fail aggregate reading; run minus that file, the suite is 188/0.

The cascade mechanism is the same class as the original N9 defect (timeout-during-`act` poisons the shared queue) — `registerDom` eliminates the window/fetch half; the React-internal queue poisoning is inherent to shared-process `act` and can only be isolated by per-file subprocesses, which the repo deliberately avoids.

## 4. Scope notes / disclosures

1. **`session-report-view.ts` (declared scope, deliberately untouched):** its wire contract (`label: "준비된 근거"`) is the persistence/payload seam — renaming it is a backend-protocol change owned by the report lane, not a copy rewrite. The plan's terminology table preserves the wire label while banning its *user-visible* rendering, which the UI now satisfies via `reportCuratedEvidence`/`reportLiveEvidence`.
2. **Literal-only edits in non-exclusive files** (`presenter-console`, `playback-panel`, `cockpit-rail`, `qa-defense-panel`, `spoken-question`, `presentation-report*`, `debug-*`, `windows-topology` tests): string contents only, no logic — each pinned a renamed catalog value and would otherwise red on copy.
3. **`private-api-proxy.test.ts`** carries a 84-line diff in the worktree that predates my edits (`git status` showed it modified before I touched anything); I did not write to it — its earlier "window is closed" flake is what `registerDom` fixes for downstream files.
4. **`reportRetry` key** was appended to both catalogs by the report-repair lane during my session; my later `evidencePrepared` copy fix used a targeted `edit`, not a rewrite, so their key survives.

## 5. Deferred / blocked

- **Aggregate green:** blocked on the sibling lane landing `subscribeFinalizedReport`/PENDING-retry product code for `presenter-console.test.tsx`'s retry test (or backing the test out). Once that file stops timing out inside `act`, the 188-green suite should extend to 194.
- **`bun test` without `NODE_ENV=test`**: the shell exports `NODE_ENV=production`, which disables React's dev-only `act` and was the original "dead DOM" trigger. Tests must run under `env NODE_ENV=test`; this is a shell/`bunfig.toml` concern, outside the copy lane.

# impromptu-ideal-experience - Work Plan

## TL;DR (For humans)

**Who this is for and what changes for them:** 발표자는 별도 공개 화면을 안전하게 연결하고
자료·발표·질문·보고서를 끊김 없이 사용합니다. 팀원은 자기 계정으로 질문만 보낼 수 있고,
청중은 승인된 슬라이드만 봅니다.

**What you'll get:** 기존 16개 격차와 제품 용어·첫 사용·재방문 동선을 함께 다루는
41개 구현 작업입니다. 실패와 복구를 포함한 실제 화면·서버·현장 검증으로
12개 사용자별 이상 상태를 확인합니다.

**Why this approach:** 공개 화면 초대는 일회용이어도 권한이 아닙니다. 발표자가 화면
식별자를 보고 승인해야 연결됩니다. 질문을 보내는 팀원에게도 발표·근거·보고서 권한을
주지 않습니다. 기존의 공개 슬라이드 전용 정책은 유지합니다.

**What it will NOT do:** 검증 전 근거를 청중에게 자동 게시하지 않으며, 유료 모델을
몰래 바꾸거나 자동 검사로 실제 프로젝터 점검을 대신하지 않습니다.

**Effort:** XL
**Risk:** High - 별도 기기 연결, 계정 권한과 실제 행사장 검증을 함께 다룹니다.
**Decisions I made for you:** 승인받은 Console 단기 초대 링크와 팀원 질문 전용 권한을
계획에 고정했습니다. 추천 응답의 5초 기준과 공개 슬라이드 전용 정책은 유지합니다.
실제 행사장 장비나 승인된 제공자 계정이 없으면 해당 완료 판정은 열어 둡니다.

Your next move: 독립 계획 검토가 승인된 뒤 별도의 실행 흐름을 시작합니다. 이 파일
작성 자체는 구현을 시작하지 않습니다.

---

> TL;DR (machine): XL, high-risk, 41 implementation rows and 7 final verification rows;
> original 23/4 retained, commercial product experience 18/3 added;
> Console/Stage/services/release user-journey closure, matching independent review still required.

## Scope
### Affected user and ideal state

This plan serves the presenter (private preparation, live control, post-talk report), a separately
authenticated teammate (question entry only), the audience (public slide only), and the
operator/privacy observer (honest release evidence). Current behavior and code-level reasons are
recorded at `.omo/drafts/impromptu-ideal-experience.md`; the paths below are the executor's
starting points, not claims that the scenarios have run.

| Row | Ideal observable state | Why it matters |
| --- | --- | --- |
| IS-1 | A PPTX/PDF and references lead to readable preparation or an actionable input/readiness error. | The presenter must know whether evidence is actually searchable before speaking. |
| IS-2 | The presenter securely pairs the exact public Stage on a separate device in Extend, Duplicate, or fallback, with fingerprint, expiry and recovery. | A wrong/unbound projector breaks the talk and privacy baseline. |
| IS-3 | Upload, preview, transport, evidence and consent/coaching are reachable at the right phase at desktop/compact widths in Korean/English and by keyboard. | A live presenter cannot hunt for essential controls. |
| IS-4 | The audience sees the correct verified public slide or an explicit public failure, never private data/cards/false READY; revision recovery never replays a stale command. | A successful HTTP receipt is not visible projection or permission to expose data. |
| IS-5 | A presenter or question-only teammate supplies the exact reviewed typed/spoken question; grounded citations or honest abstention remain private and revocable. | Room noise must not turn a teammate's assistance into fabrication or broad account authority. |
| IS-6 | The finalized report appears after PENDING, survives reload and identifies slides, speech/coaching and Q&A without raw hashes. | Post-talk value must persist beyond the first redirect. |
| IS-7 | Expiry, denial, unavailable OCR/provider/asset and reconnect errors show truthful safe recovery and clear stale/private state. | Silent failure and stale authority degrade both UX and security. |
| IS-8 | Present-tree checks, real Chrome/Edge journeys and actual Windows venue runs each prove only their own scope; no historical receipt stands in for them. | Local green tests cannot certify a room's physical pixels. |

| Row | Verified current gap / resolution boundary | Closes in |
| --- | --- | --- |
| GAP-1 | Existing dirty UX Round 2 edits have no integrated browser proof; retain and verify each of C1-C8, fix only reproduced failures. | 1, 20, 23 |
| GAP-2 | Separate-device Stage is inert despite supported topology and Console's copy-code fallback. | 2, 6, 7, 12, 13 |
| GAP-3 | Venue script promises public cards but current backend/gateway return 410 and Stage is slide-only. | 4, 21, 23 |
| GAP-4 | Join expiry/reconcile errors can be silent and HTTP applied receipts are not narrowed. | 2, 15, 23 |
| GAP-5 | No distinct teammate question-entry surface or scoped grant exists. | 4, 8, 14, 22 |
| GAP-6 | Earlier 9/10 and later 10/10 recommendation receipts disagree across commits; final-tree reliability is unmeasured. | 3, 19, 23 |
| GAP-7 | Physical projector rehearsal is not recorded; automated ten-run tests do not replace it. | F3, F4 |
| GAP-8 | Spoken-question STT deadline is minted once at backend startup. | 9, 22 |
| GAP-9 | Live coaching aggregates are omitted by production report wiring. | 10, 18, 22 |
| GAP-10 | New deck retains active slide index; sign-out retains private presentation/binding state. | 1, 16, 22 |
| GAP-11 | Rebinding sends constant `dbe_0` and pending display identity is not visible. | 2, 7, 12, 22 |
| GAP-12 | Reference read failure looks empty, raw backend reasons appear, OCR can yield image-only success without readiness warning. | 3, 17, 20 |
| GAP-13 | Stage may report READY over a blank unverified SVG; command acceptance is not rendered output. | 2, 15, 23 |
| GAP-14 | Report `PENDING` is read once and can remain stuck. | 11, 22 |
| GAP-15 | Awaiting recommendation in FINAL processing can delay the next transcript; reproduce with two events first. | 3, 10, 22 |
| GAP-16 | Browser-runtime checker expects a removed fullscreen button and omits Console accessibility routes. | 5, 20, 23 |

### Must have

- Use the approved Console-issued, 90-second or shorter, one-use **non-authorizing** invitation.
  Console authenticates and creates the invitation for the active deck; Stage exchanges it for
  its own public join, then only a fresh presenter gesture approves the exact visible display
  fingerprint and current binding CAS. A URL or join locator never grants display authority.
  Do not put account/session/CSRF data in URL, Stage storage, logs, or public payloads.
- Give independently signed-in teammate B one session-scoped, revocable question-submission
  capability. B sends the text into the owner's private inbox; the owner reviews and explicitly
  submits it through the existing owner-authorized post-talk Q&A flow. B cannot invoke
  recommendations, playback, capture, publication or report reads. Unrelated account C cannot
  read/write; revocation and session end block B immediately. Persist the narrow grant/inbox
  with an ordered private migration after `infra/migrations/private/0011_qa_exchanges.sql`.
- Keep the documented 5,000 ms recommendation bound, typed abstention and deterministic evidence
  gate; do not convert a 200 abstention into a usefulness PASS.
- Preserve existing changes to Console files and `.omo` plans made by another session. Work in
  task-owned worktrees; integrate only verified increments without destructive git operations.

### Must NOT have (guardrails, anti-slop, scope boundaries)

- Do not enable public cards/live publication, add a private import to Stage/gateway, or weaken
  closed DTOs, exact-origin/CSRF checks, tenant ACLs, display CAS, evidence verification, or
  the sign-out privacy boundary.
- Do not invent a new recommendation provider, paid service, broader teammate role, auto-submit
  spoken question, new browser AI runtime, or generated report summary to satisfy this plan.
- Do not alter applied migrations or suppress failing tests/lint. Never claim physical sign-off
  from macOS, headless Chrome, fixtures, or historical evidence. No target hardware = open gate.

## Verification strategy

Test decision: **failing-first TDD** for each reproduced behavior bug; tests-after for new
closed contracts and permissions. Reuse Bun tests next to their owner and Python pytest next to
ingestion. A test is added only when an existing suite would miss a regression. No prose-string
tests for documentation corrections. Avoid sleeps: subscribe to the event before the action and
await a bounded state deadline; use an injected clock for expiry.

Evidence root for a later execution session: query `agentToolkit.status().result.currentAttemptDir`
through the JS SDK and use `<attemptDir>/task-N/{before,after,qa,cleanup}.*`. The executor resolves
the literal attempt directory before launching tasks and replaces `<attemptDir>` in each scenario;
each artifact is non-empty and tied to the final git tree. Server/browser/container/profile
teardown is a paired todo and a one-line receipt beside every QA artifact. A baseline-only task
does not count as a production fix. For every command below, save stdout/stderr and exit code.

Shared local topology: `bun run dev` launches private backend at `127.0.0.1:3001`, public gateway
at `127.0.0.1:3002`, Console at `localhost:4173`, Stage at `localhost:4174`
(`scripts/dev-services.ts:1-83`). Start it as a monitored background session, verify backend
auth and the real browser flow, then stop the session and check all four ports are unbound.
Never substitute `127.0.0.1` for browser `localhost` origins without aligning CORS.

Browser channel: load omowright from the `browser` skill in JS eval; create two *task-owned*
profiles with `connectPipe`, one private Console and one public Stage; log `newTab`, `goto`,
`locator(...).fill/click`, navigation, network receipts and `page.screenshot()` to task artifacts.
Use `localhost:4173/sign-in`, local fixture `localdemo` / `demo-2026-password`, then upload a
fixture via `page.locator('input[type=file]').setInputFiles(<fixture>)`. Stage uses
`localhost:4174/?deck=<returned-deckVersion>#invite=<one-use-invitation>` in an
independent profile with no opener (fragment form; the earlier query example is
superseded by the fragment transport rule and secret-bearing query URLs are never
logged or shipped as evidence). Selectors include `[data-sign-in-username]`,
`[data-sign-in-password]`, `[data-sign-in-submit]`, `[data-copy-stage]`,
`[data-transport-strip]`, `[data-qa-question-input]` and `[data-audience-readiness]`.
After each visual edit capture and inspect desktop 1440x900, presentation 1024x768 and
mobile 375x812 in Korean and English; also run 320 px/200% zoom and keyboard/forced-colors
checks. The finalized invitation route/query shape is set by task 6; no secret-bearing URL
may be logged or shipped as an evidence artifact. Record only redacted action logs.

HTTP channel: use `curl -i` with exact origin, same-origin Referer, session cookie and CSRF
for private mutations. Exercise public `POST /v1/display-joins`, claim, snapshot, realtime
receipt and negative `/internal/cards`; save status line, headers and redacted body. No public
response/log/artifact may contain private deck text, candidate, transcript, teammate question,
account cookie or authorization token. Use task-owned test credentials, never production data.

Repository gate on the integrated tree: `bun run lint`, `bun run typecheck`, `bun run test`,
`bun run build`, `bun run check:boundaries`, `bun run check:browser-boundary`,
`bun run check:browser-runtime`, `bun run test:e2e`, `bun run test:security`, and
`uv run --project services/ingestion pytest`; each must exit 0 without skips added.
Database/migration tests require an isolated Docker database. `bun run test:aggregate:10`
remains an automated ten-run gate, not physical venue proof.

## Execution strategy
### Parallel execution waves
One mass-ulw workflow run per dependency-ordered phase, not one graph spanning the job.
Topology lock: (A) baseline/reproduction, (B) private/public contracts and focused fixes,
(C) Console/Stage integration, (D) integrated proof and release. Each run has 5-8 producer
nodes plus one read-only verification/fan-in node; `dependsOn` orders consumers only, does
not pass upstream output. Between runs the lead reads artifacts, verifies claims and builds
the next graph from the settled facts. Independent source domains run concurrently with
disjoint write scopes; DTO/schema+producer+consumer changes that cannot remain buildable
alone stay in one node or serialize. `quick` is default for mechanical single-file work,
`visual-engineering` for browser UI, `deep-low` for concurrency root fixes, `deep-high` only
for the new security contract/permission model. No team: shared contracts create real
dependencies rather than two substantial lanes that must converse concurrently.

- Wave A (tasks 1-5): baseline probes and a falsifiable gap inventory, no product edits.
- Wave A ownership gate: task 1 records `git status --short` and hashes/diffs of every
  pre-existing dirty file. Before a later task edits an overlapping path (notably
  `apps/console/src/audience-screen.ts`, `App.test.tsx`, `console.css`,
  `presentation-report.tsx` or locale JSON), the lead first confirms the concurrent
  owner has finished or delegates a non-overlapping slice; a conflicting write is
  paused and surfaced rather than overwritten. An isolated worktree starts from HEAD
  and does **not** silently include someone's uncommitted UX Round 2 work; retain a
  reviewed snapshot and explicitly rebase the task's intended diff onto the actual
  settled integration tree using `apply_patch`, preserving user-owned hunks. No
  destructive git checkout/reset, raw `git apply`, or blanket stage.
- Wave B (tasks 6-11): invitation protocol/authority, private teammate grants, clock/audio and
  report fixes; contracts precede UI.
- Wave C (tasks 12-18): browser flows, asset/receipt fail-closed behavior, account/reference
  feedback and coaching report wiring.
- Wave D (tasks 19-23): current-tree provider/UX gates, accessibility/release guidance and
  integrated browser/security acceptance. F1-F7 all run once, after task 41, on the
  final integrated tree; the original F1-F4 rows were written for the 23-task scope
  and evaluate the full 1-41 scope per their amended text.

### Mass-ulw run definitions for the executor

The executor reads the `mass-ulw` planning reference before starting any run. Use
`sdk.define({key:"impromptu-ideal-A-<integration-tree>",name:"Baseline"})` and analogous
unique B/C/D keys; a settled run is recovered with `retry` or `amend`, never a new key
for the same phase. In each run a verifier node depends on *all* producer nodes,
checks actual artifact files and exact exit codes, and rejects a child that merely
said "PASS". The lead alone checks the real browser/HTTP artifacts and integrates
commits. Do not define a whole-job graph or start the next run before auditing the
preceding run's results.

| Run | Producer nodes (`id`: todo / category) | Intra-run edges | Verifier |
| --- | --- | --- | --- |
| A | `console-baseline`: 1 / visual-engineering; `stage-baseline`: 2 / visual-engineering; `service-baseline`: 3 / deep-low; `security-baseline`: 4 / deep-low; `release-baseline`: 5 / quick | All independent read-only; no writes to shared files. | `verify-A` / quick, depends on all 5; require five bounded reports and preserve red failures. |
| B | `invite-contract`: 6 / deep-high; `invite-authority`: 7 / deep-high; `team-grant`: 8 / deep-high; `clip-deadline`: 9 / quick; `final-forwarding`: 10 / deep-low; `pending-report`: 11 / visual-engineering | 7 depends on 6; 8 depends on 7 to serialize backend route registration; 9/10/11 are independent. | `verify-B` / unspecified-low, depends on all 6; require each unit's tests and incremental build; commits only if separately authorized. |
| C | `console-invite`: 12 / visual-engineering; `stage-invite`: 13 / visual-engineering; `team-ui`: 14 / visual-engineering; `stage-recovery`: 15 / deep-low; `console-identity`: 16 / deep-low; `reference-ocr`: 17 / deep-low; `coaching-report`: 18 / deep-low | 15 depends on 13; others are disjoint write scopes given B complete. | `verify-C` / unspecified-low, depends on all 7; verify two-browser invitation, B-only Q&A and Stage zero cards. |
| D | `recommendation-gate`: 19 / deep-low; `browser-a11y`: 20 / visual-engineering; `release-doc`: 21 / writing; `integration-e2e`: 22 / deep-low; `integrated-proof`: 23 / unspecified-high | 19/20/21/22 start together; 23 depends on all 4. | `verify-D` / unspecified-high, depends on 23 and reads all four prior receipts and final-tree browser output. |

Every node prompt is self-contained: `TASK`, `DELIVERABLE`, hard read/write `SCOPE`,
literal `VERIFY`, `STOP WHEN`, references, and `<attemptDir>` resolved before dispatch.
Do not spawn two concurrently writable nodes against the same checkout: each producer
gets an isolated task-owned worktree, with contract/schema changes landed before
consumers start. A source tree modified by another session is never reset. A
verification node is read-only. F1-F7 are the separate final-verification wave after
the last implementation task (41) settles, not a fifth implementation graph, and run
once on the final tree rather than once per wave.

The critical path is 1/2/4 -> 6 -> 7 -> 12/13 -> 15 -> 22 -> 23 -> (24-41 chain) -> F1-F7, alongside
4 -> 8 -> 14 -> 22. A runtime defect found in Wave A is registered as a named task before
Wave D, not waved away as a baseline note.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1-5 | None | 6-23 | Each other; read-only |
| 6 | 2,4 | 7,12,13 | 8-11 after their own prerequisites |
| 7 | 6 | 12,13 | 8-11 |
| 8 | 4,7 | 14 | 9-11 |
| 9 | 3 | 22 | 6-8,10,11 |
| 10 | 3 | 18,22 | 6-9,11 |
| 11 | 1 | 22 | 6-10 |
| 12 | 6,7 | 22 | 14,16-18; serialize with 13 if shared contracts shift |
| 13 | 6,7 | 15,22 | 14,16-18 |
| 14 | 8 | 22 | 12,13,16-18 |
| 15 | 13 | 22,23 | 14,16-18 |
| 16 | 1 | 22 | 12-15,17,18 |
| 17 | 3 | 20,22 | 12-16,18 |
| 18 | 10 | 22 | 12-17 |
| 19 | 3,9,10,17 | 23 | 20,21 after their dependencies |
| 20 | 1,5,12,14,15,17 | 23 | 19,21 |
| 21 | 4,5,15 | 23 | 19,20 |
| 22 | 7-18 | 23 | None if it changes shared integration contracts |
| 23 | 19-22 | 24-41, then F1-F7 | None |

## Todos
> Implementation + its regression test + real-surface proof are one task. Append the numbered tasks here.

- [ ] 1. Capture the presenter's actual Console baseline and protect dirty UX work
  - Closes: GAP-1, establishes reproduction for GAP-10 and GAP-14; Wave A, no writes.
  - References: `apps/console/src/workspace-page.tsx:40-42,186-258`,
    `apps/console/src/auth-session.tsx:71-80,120-133`,
    `apps/console/src/report-page.tsx:44-103`,
    `.omo/plans/ux-round2.md:1-23`, `apps/console/DESIGN.md:38-125`.
  - Acceptance: record `git status --short` and task-owned browser screenshots for all eight
    UX Round 2 criteria at 1440x900, 1024x768 and 375x812; sign in, upload a long deck,
    change slide, replace it with a shorter deck, sign out/sign in as another account, end
    and return a PENDING report. Name each PASS/FAIL without modifying user files.
  - QA: happy `bun test apps/console/src/App.test.tsx apps/console/src/presenter-console.test.tsx`
    exits 0 and omowright Console `[data-transport-strip]` remains reachable; failure branch
    injects short deck/PENDING/second account and records current wrong preview, permanent wait
    or stale private UI, not a synthetic green. Evidence
    `<attemptDir>/task-1/{console-baseline.png,console-compact.png,baseline.log,failures.json,cleanup.txt}`.
  - Recommended task executor category: `visual-engineering` - phase layout needs actual
    desktop/mobile screenshot judgment.
  - Commit: N; baseline only, preserve every pre-existing dirty path.

- [ ] 2. Reproduce one-machine and independent-device Stage pairing and asset failures
  - Closes: GAP-2 baseline, GAP-4 baseline, GAP-11 baseline, GAP-13 baseline; Wave A, no writes.
  - References: `apps/stage/src/landing-page.tsx:29-63,100-145`,
    `apps/stage/src/display-page.tsx:80-143`, `apps/stage/src/slide-view.tsx:44-72`,
    `apps/stage/src/App.test.tsx:501-557`,
    `apps/console/src/display-playback.ts:48-68`,
    `services/projection-gateway/src/prepared-evidence.ts:441-506`.
  - Acceptance: use two task-owned Chrome profiles with no opener: Console copies
    `[data-copy-stage]`, independent Stage opens URL, then close/reopen a first successful
    opener-created binding; separately block the verified SVG request. Capture whether second
    device is inert, whether rebinding returns `BINDING_CAS_CONFLICT`, and whether READY is blank.
  - QA: happy opener-created Stage reaches `[data-audience-readiness=READY]` with a visible
    slide; failure variants preserve exact HTTP receipt, independent-device screenshot, and
    blocked-asset screenshot, rather than trusting READY alone. Evidence
    `<attemptDir>/task-2/{opener.png,independent-device.png,rebind.http,asset-failure.png,cleanup.txt}`.
  - Recommended task executor category: `visual-engineering` - browser pairing and rendered
    slide observations decide the diagnosis.
  - Commit: N; reproduction only.

- [ ] 3. Capture current ingestion, STT, coaching and recommendation behavior
  - Closes: GAP-6 baseline, GAP-8/9/12/15 reproduction; Wave A, no writes.
  - References: `services/private-backend/src/qa/spoken-question-stt.ts:44-57`,
    `services/private-backend/src/audio-ingest.ts:178-187,463-476`,
    `services/private-backend/src/bootstrap/audio.ts:47-59`,
    `services/ingestion/src/impromptu_ingestion/adapters/pdf.py:68-87`,
    `.omo/evidence/task-50/final-state.json`, `.omo/evidence/task-53/receipts.json`.
  - Acceptance: run existing focused backend/Python tests and one live valid/scanned/invalid
    deck upload with task-owned fixtures. Distinguish HTTP completion, RECOMMEND verdict,
    OCR text availability and coaching persisted in report; never assert today's provider
    rate from a historical commit. Capture a two-FINAL deferred-provider probe, not a sleep.
  - QA: happy `bun test services/private-backend/test/audio-ingest-http.test.ts
    services/private-backend/test/qa-http.test.ts` and `uv run --project services/ingestion
    pytest services/ingestion/tests/test_adapters.py -k ocr` exit 0; failure injects absent
    OCR executable and held recommendation while FINAL B arrives, recording real status and
    SSE order. Evidence `<attemptDir>/task-3/{tests.log,upload.http,final-order.log,cleanup.txt}`.
  - Recommended task executor category: `deep-low` - disparate timing and evidence receipts
    require causal diagnosis before fixing.
  - Commit: N; baseline only.

- [ ] 4. Freeze the existing public/private and teammate authorization baseline
  - Closes: GAP-3 baseline, GAP-5 baseline; Wave A, no writes.
  - References: `services/private-backend/src/http/routes/qa-defense.ts:158-232`,
    `services/private-backend/src/http/routes/playback-read.ts:11-18`,
    `services/projection-gateway/src/http.ts:397-403`,
    `packages/contracts/src/public-protocol.ts:52-65`,
    `tests/security/release-security.test.ts`.
  - Acceptance: establish owner A, separately signed-in B and unrelated C; record B's current
    inability to submit a session question and C's denial. Verify Stage snapshot, SSE/WSS
    and ingress contain zero cards and no private question data. Store redacted responses.
  - QA: happy `bun run test:security` exits 0 and
    `curl -i -X POST http://127.0.0.1:3002/internal/cards -H 'Authorization: Bearer
    local-development-token' -H 'Content-Type: application/json' -d '{}'` returns
    `410 stage_cards_disabled`; failure variants remove the internal bearer token and request
    snapshot without the Stage cookie, yielding 401 and zero private bytes. Evidence
    `<attemptDir>/task-4/{security.log,cards.http,anonymous-snapshot.http,cleanup.txt}`.
  - Recommended task executor category: `deep-low` - account separation and boundary evidence
    must be assessed together.
  - Commit: N; baseline only.

- [ ] 5. Inventory release guidance and browser-runtime coverage against the live UI
  - Closes: GAP-16 baseline, GAP-7 release-input inventory; Wave A, no writes.
  - References: `scripts/verify-browser-runtime.ts:677-721`,
    `docs/accessibility-matrix.md:5-27`, `docs/final-manual-qa.md:9-19,48-111`,
    `docs/DEMO-SCOPE.md:9-30,55-74,169-172`.
  - Acceptance: record removed `[data-stage-fullscreen]` selector, missing Console
    accessibility routes, stale card-publish checklist, supported Windows devices and the
    physically unavailable inputs; identify no hardware claim from source inspection.
  - QA: happy `bun run check:browser-boundary` exits 0 with its stdout archived; failure
    `bun run check:browser-runtime` is run once against the current build with a bounded
    monitor and its actual exit/selector error archived (a pre-existing failure is a finding,
    not a test to skip). Evidence `<attemptDir>/task-5/{browser-boundary.log,runtime.log,
    inventory.md,cleanup.txt}`.
  - Recommended task executor category: `quick` - concrete scanner/selector inventory.
  - Commit: N; baseline only.

- [ ] 6. Define and persist the non-authorizing Stage invitation protocol
  - Closes: GAP-2 protocol/expiry foundation; Wave B, blocked by 2 and 4; blocks 7,12,13.
  - References: `packages/contracts/src/public-protocol.ts:52-65`,
    `services/projection-gateway/src/prepared-evidence.ts:79-85,199-232,410-535`,
    `services/projection-gateway/src/http.ts:397-455,480-548`,
    `infra/migrations/projection/0005_gateway_state.sql`.
  - Acceptance: add a closed DTO for `{invitationId, token, deckVersion, expiresAtMs}` and
    `POST /internal/display-invitations` (service bearer only). Mint >=128 random bits;
    store **only a digest** of the token in a separately versioned projection record/table
    (not a new field in the existing closed gateway snapshot), and reject
    unknown/expired/consumed/wrong-deck tokens. Verify that the previous binary can restore
    its existing snapshot after invitation issuance. A public
    `POST /v1/display-joins` carrying an invitation may create one pending join but never a
    display cookie or binding. Keep bare Stage `/` inert without an invitation; do not weaken
    existing opener join tests. Persist/recover after gateway restart within TTL, expire at
    exactly `expiresAtMs`, and consume atomically before any second request succeeds.
  - QA: happy `bun test services/projection-gateway/test/prepared-evidence.test.ts
    services/projection-gateway/test/session-http.test.ts` exits 0 and live
    `curl -i -X POST http://127.0.0.1:3002/v1/display-joins -H
    'Origin: http://localhost:4174' -H 'Referer: http://localhost:4174/' -H
    'Content-Type: application/json' --data-binary @<attemptDir>/task-6/join.json` returns 201 with
    locator only; failure repeats the same invitation, wrong deck, missing bearer, expired
    timestamp and post-restart replay, yielding typed 4xx and zero binding. Evidence
    `<attemptDir>/task-6/{contracts.log,join.http,negative.http,restart.log,cleanup.txt}`.
  - Recommended task executor category: `deep-high` - new cross-package security contract
    and durable one-use invariant cannot be copied mechanically.
  - Commit: N unless separately requested; draft subject `feat(projection): add one-use display invitations`.

- [ ] 7. Authorize invitations and rebind from current private authority
  - Closes: GAP-2 private authority and GAP-11 CAS; Wave B, blocked by 6; blocks 12,13,22.
  - References: `services/private-backend/src/http/routes/coordinator-commands.ts:78-110`,
    `services/private-backend/src/prepared-evidence.ts` (`approveDisplay`, ownership),
    `services/private-backend/src/projection-http-port.ts`,
    `apps/console/src/display-playback.ts:48-68`,
    `services/projection-gateway/src/prepared-evidence.ts:466-506`.
  - Acceptance: authenticated exact-Origin/CSRF owner calls
    `POST /v1/display-invitations` for the current presentation; backend requests gateway's
    internal invitation and returns a redacted public URL. An authenticated
    `GET /v1/display-invitations/:id/pending` resolves only the owner-visible
    display ID/fingerprint/deck, expiry and authoritative current binding epoch; no token,
    private deck or unrelated join in the response. Existing
    `POST /v1/display-bindings` uses that fresh epoch, not `"dbe_0"`, for both independent
    Stage and reopen. Wrong owner, wrong fingerprint, expired/replayed token and stale CAS
    reject before any public projection side effect.
  - QA: happy `bun test services/private-backend/test/prepared-evidence.test.ts
    services/private-backend/test/http.test.ts` exits 0; live authenticated `curl -i -X POST
    http://127.0.0.1:3001/v1/display-invitations` with exact Origin/Referer/cookie/CSRF and
    current session JSON returns a nonauthorizing URL, then a second bind returns 201 with
    next `dbe_N`. Failure C's cookie, forged fingerprint and old epoch yield 403/409 and
    old Stage loses authority. Evidence
    `<attemptDir>/task-7/{invite.http,rebind.http,negative.http,cleanup.txt}`.
  - Recommended task executor category: `deep-high` - owner authorization, CAS and
    private-to-public boundary must be correct as one increment.
  - Commit: N unless separately requested; draft subject `feat(private): authorize public display invitations and rebind`.

- [ ] 8. Persist a revocable question-only teammate grant and owner inbox
  - Closes: GAP-5 service contract; Wave B, blocked by 4 and serialized after 7 where
    authenticated route registration overlaps; blocks 14 and 22.
  - References: `infra/migrations/private/0011_qa_exchanges.sql`,
    `services/private-backend/src/http/routes/qa-defense.ts:158-232`,
    `services/private-backend/src/http/routes/coordinator-commands.ts:142-154`,
    `services/private-backend/src/http/handler.ts`,
    `services/private-backend/src/account-session-store.ts`.
  - Acceptance: new ordered private `0012_team_questions.sql` has FK-scoped owner,
    presentation, target teammate account, expiry, revocation revision and append-only
    question rows; supply an in-memory equivalent for existing dev topology. Owner A
    grants/revokes B only while authenticated with CSRF; B independently signs in,
    accepts an opaque nonauthorizing invitation targeted to B, and can POST bounded
    question text only to that session's private inbox. Tables
    `private_app.team_question_grants` and `private_app.team_questions` use
    `(tenant_id uuid, session_id uuid)` FK to `presentation_sessions`, account-ID
    text FKs to `accounts`, bounded question text, a unique hashed invitation and
    idempotency key, and owner-tenant RLS modeled on `0011_qa_exchanges.sql`.
    A B request resolves its exact grant under authenticated account identity
    before any owner-tenant read/write; do not grant generic cross-tenant SELECT.
    `GET /v1/team-questions` is
    owner-only; B receives only its submission receipt, never deck, recommendation,
    report, other questions or publication/playback authority. Recheck active grant
    adjacent to each private write, reject replay after revocation/session end/expiry.
    Owner Q&A route and stored exchange ownership remain unchanged.
  - QA: happy `bun test services/private-backend/test/qa-http.test.ts
    services/private-backend/test/account-registration-http.test.ts` plus isolated
    `bun run test:db` exit 0; live A/B/C browser profiles prove B POST returns 202 and A's
    private inbox shows the exact text. Failure C, B after revoke/end, B attempting owner
    report or playback, malformed/excessive text and concurrent duplicate invitation use
    yield typed denial and zero cross-tenant rows. Evidence
    `<attemptDir>/task-8/{migration.log,grants.http,denials.http,inbox.png,cleanup.txt}`.
  - Recommended task executor category: `deep-high` - new private schema/role, isolation
    and transaction/revocation invariants cross packages.
  - Commit: N unless separately requested; draft subject `feat(private): scope teammate question grants and inbox`.

- [ ] 9. Mint each spoken-question STT deadline at invocation time
  - Closes: GAP-8; Wave B, blocked by 3; blocks 19/22.
  - References: `services/private-backend/src/qa/spoken-question-stt.ts:44-57`,
    `services/private-backend/test/qa-http.test.ts`, adjacent STT adapter tests.
  - Acceptance: reproduce with injected clock advancing past backend startup +60s,
    then move `Date.now()` into the returned per-clip function so each trusted context has
    its own 60s deadline; preserve local adapter, bounded clip and typed rejection mapping.
  - QA: happy `bun test services/private-backend/test/qa-http.test.ts` exits 0 with a second clip deadline in the
    future; failure old behavior test fails before the fix when clock advances, and
    unsupported codec/empty audio still rejects. Live post-talk Console clip after an
    elapsed backend session returns transcription rather than immediate expired policy.
    Evidence `<attemptDir>/task-9/{red.log,green.log,clip.http,cleanup.txt}`.
  - Recommended task executor category: `quick` - one local stale-clock fix with owner test.
  - Commit: N unless separately requested; draft subject `fix(private): refresh spoken question deadline per clip`.

- [ ] 10. Forward consecutive FINAL speech without provider head-of-line blocking
  - Closes: GAP-15 and establishes GAP-9 timing seam; Wave B, blocked by 3; blocks 18,22.
  - References: `services/private-backend/src/audio-ingest.ts:178-187,430-476`,
    `services/private-backend/test/audio-ingest-http.test.ts:416-510`,
    `services/private-backend/src/bootstrap/audio.ts:47-59`.
  - Acceptance: first prove FINAL B cannot reach SSE while FINAL A recommendation is held
    on an unresolved deferred promise. Dispatch recommendation outside transcript
    forwarding with a per-presentation bounded, cancellable lane that preserves each FINAL's
    identity and report order; grant stop, session end and disconnect abort outstanding work,
    and a late result cannot attach to a new session/slide. Preserve recommendation deadline
    and deterministic evidence gate.
  - QA: happy `bun test services/private-backend/test/audio-ingest-http.test.ts` exits 0;
    subscribe to SSE before emitting FINAL A then B, observe both transcript IDs before
    resolving A's provider. Failure provider reject, cancellation and third simultaneous
    FINAL produce typed/private outcomes with no unbounded queue or late public leak. Also
    drive a live two-utterance local capture and archive event order. Evidence
    `<attemptDir>/task-10/{red.log,green.log,sse.log,cleanup.txt}`.
  - Recommended task executor category: `deep-low` - concurrency/cancellation mechanism
    must be settled from existing audio lifecycle invariants.
  - Commit: N unless separately requested; draft subject `fix(private): decouple speech forwarding from recommendation`.

- [ ] 11. Recover a finalized report automatically after PENDING
  - Closes: GAP-14; Wave B, blocked by 1; blocks 22.
  - References: `apps/console/src/report-page.tsx:44-70`,
    `apps/console/src/playback-panel.tsx:151-191`,
    `apps/console/src/session-report-stream.ts:47-105`,
    `apps/console/src/presentation-report-page.test.tsx:123-135`.
  - Acceptance: reproduce PENDING then FINALIZED without navigation; use existing
    owner-scoped report event/subscription where possible, registering it before the first
    read and tearing it down on unmount/session change. If event channel is unavailable,
    expose one explicit retry control rather than a fixed-sleep test or permanent spinner.
    Invalid/nonowner response stays forbidden; no second end mutation occurs.
  - QA: happy `bun test apps/console/src/presentation-report-page.test.tsx` exits 0
    with a deferred report event and browser `/reports/<session-id>` moves PENDING -> READY
    without reload; failure lost event exposes retry, 403 never discloses report. Evidence
    `<attemptDir>/task-11/{red.log,green.log,pending.png,ready.png,cleanup.txt}`.
  - Recommended task executor category: `visual-engineering` - route-level async status
    and recovery feedback need browser confirmation.
  - Commit: N unless separately requested; draft subject `fix(console): recover pending reports without reload`.

- [ ] 12. Give the presenter a secure two-device invitation and visible identity check
  - Closes: GAP-2 and GAP-11 Console UX; Wave C, blocked by 6/7; blocks 20/22.
  - References: `apps/console/src/audience-panel.tsx:43-143`,
    `apps/console/src/audience-screen.ts:43-70,182-240`,
    `apps/console/src/display-playback.ts:48-68`,
    `apps/console/src/workspace-page.tsx:43-65,208-258`,
    `apps/console/src/audience-screen.test.tsx:129-531`.
  - Acceptance: "copy Stage link" invokes owner-only invitation issuance and copies the
    short-lived URL, not the inert bare URL. Present expiry and a "check connection request"
    control using the owner-scoped pending endpoint from 7; show actual display ID and
    fingerprint adjacent to a clearly labelled explicit approval button. Rebind uses the
    authoritative epoch and preserves the current slide, including after popup closure.
    An opener-created same-device Stage still follows its existing secure flow. On timeout,
    wrong deck, popup blocked or rejected CAS show one actionable recovery, not a success badge.
  - QA: happy `bun test apps/console/src/audience-screen.test.tsx
    apps/console/src/playback-panel.test.tsx` exits 0 and omowright private Console click
    `[data-copy-stage]`, open the link in a second isolated Stage profile, click check,
    compare visible fingerprint, then `[data-display-approve]`; Stage shows same slide after
    reopen. Failure forged origin/source, wrong fingerprint, expired invitation, stale CAS
    show no connected status and no private URL in screenshots/logs. Evidence
    `<attemptDir>/task-12/{invite-console.png,fingerprint.png,reopen.png,negative.log,cleanup.txt}`.
  - Recommended task executor category: `visual-engineering` - two-browser human
    confirmation and status layout must be inspected.
  - Commit: N unless separately requested; draft subject `feat(console): guide secure second-device pairing`.

- [ ] 13. Consume an invitation on independent Stage without self-authorizing
  - Closes: GAP-2 Stage UX and expiry; Wave C, blocked by 6/7; blocks 15/22.
  - References: `apps/stage/src/landing-page.tsx:9-145`,
    `apps/stage/src/stage-client.ts:310-360`,
    `apps/stage/src/App.test.tsx:441-559`,
    `apps/stage/src/locales/ko.json`.
  - Acceptance: direct bare Stage `/` remains inert and public. On
    `/?deck=<public-deck>#invite=<opaque>` read the fragment once in memory,
    clear it with `history.replaceState`, validate token/expiry at the gateway boundary,
    and submit one join to gateway
    and show a minimal public waiting/expired/retry state. Only the gateway's one-use
    claim after presenter's approval navigates to `/display/:displayId`; invalid/replayed
    invitation never returns account/session fields, and Stage does not import private
    packages. Do not load third-party assets on invitation landing; use
    `Referrer-Policy: no-referrer` and `Cache-Control: no-store` for that page,
    then set `referrerPolicy: "same-origin"` on Stage's same-origin `/v1` mutation fetches
    so the gateway's exact Origin/Referer checks remain intact. Verify the actual browser
    headers and keep the token out of event logs, SW cache and browser storage.
  - QA: happy `bun test apps/stage/src/App.test.tsx apps/stage/src/stage-client.test.ts`
    exits 0 and omowright opens the copied URL with no opener: one POST join then awaiting
    approval, followed by slide-only display after approval. Failure wrong/expired/replayed
    invite, bare URL and denied claim show no unauthorized slide or private fields. Evidence
    `<attemptDir>/task-13/{waiting.png,approved.png,expired.png,network-redacted.log,cleanup.txt}`.
  - Recommended task executor category: `visual-engineering` - public landing/error pixels
    and browser URL lifecycle need visual confirmation.
  - Commit: N unless separately requested; draft subject `feat(stage): join only through approved invitations`.

- [ ] 14. Add the teammate's private question-entry and presenter's review path
  - Closes: GAP-5 browser surface; Wave C, blocked by 8; blocks 20/22.
  - References: `apps/console/src/console-routes.tsx:11-31`,
    `apps/console/src/qa-defense-panel.tsx:20-25,46-165`,
    `apps/console/src/qa-defense.ts:23-28,165-206`,
    `apps/console/src/report-page.tsx:84-103`,
    `services/private-backend/src/http/routes/qa-defense.ts:158-232`.
  - Acceptance: owner issues a question-only invitation targeted to B's account, sees
    submitted questions in a private labelled inbox, chooses a question to place into the
    post-talk Q&A draft, reviews/edits it and explicitly submits as owner. Separately
    authenticated B opens `/team/questions/<opaque-invite>` and can submit bounded text
    with private receipt, without viewing A's deck, answers, reports or Stage. Questions
    entered during the live talk queue privately until the owner's post-talk Q&A opens;
    duplicate request IDs are idempotent, genuinely new identical questions remain distinct.
    Revocation/expiry is reflected in B's form and prevents later writes. Remove the
    invite token from B's URL immediately, set no-referrer/no-store and never put
    teammate question text in a URL, browser log or public projection.
  - QA: happy `bun test apps/console/src/qa-defense-panel.test.tsx
    apps/console/src/App.test.tsx services/private-backend/test/qa-http.test.ts`
    exits 0; in three isolated browser profiles A grants B, B types "2분기 매출은?",
    A sees that exact question, explicitly submits and receives a cited answer or abstention.
    Failure C's link, B after revoke, pre-open Q&A, duplicate request ID and Stage DOM
    yield denial, no duplicate message and zero public question bytes. Evidence
    `<attemptDir>/task-14/{teammate.png,owner-inbox.png,denials.http,stage.png,cleanup.txt}`.
  - Recommended task executor category: `visual-engineering` - two private roles and
    ownership-facing UI require browser validation.
  - Commit: N unless separately requested; draft subject `feat(console): review teammate questions privately`.

- [ ] 15. Close Stage HTTP receipt and visible-asset recovery boundaries
  - Closes: GAP-4 and GAP-13; Wave C, blocked by 13; blocks 20/22/23.
  - References: `services/projection-gateway/src/http.ts:550-584`,
    `services/projection-gateway/src/main.ts:71-112`,
    `apps/stage/src/stage-client.ts:330-353,461-490`,
    `apps/stage/src/use-stage-subscription.ts:55-81,124-145,170-230`,
    `apps/stage/src/slide-view.tsx:44-72`,
    `apps/stage/src/display-page.tsx:89-143`.
  - Acceptance: gateway parses and narrows `/v1/stage-applied` response to the same closed
    public receipt DTO as WSS; Stage rejects extra/private/malformed response fields.
    Fetch SVG and PNG as bounded bytes, verify each against `imageContentHash` before
    rendering, and revoke any temporary object URLs on slide/session teardown. Only
    verified asset load/render may set READY/visible applied status; failed
    hash, asset 404 or expired display session leads to a public, non-private failure state
    and an actionable private Console retry, never blank READY or stale card. Reconcile
    exhaustion terminates visibly, bounded at existing `RECONCILE_RECOVERY_LIMIT`.
    A locally cached public slide during a network partition stays visible only under a
    named offline indicator until authoritative reconnection; never infer new authority.
  - QA: happy `bun test apps/stage/src/App.test.tsx
    apps/stage/src/stage-client.test.ts services/projection-gateway/test/events-http.test.ts`
    exits 0; live HTTP receipt contains only public fields and Stage screenshot shows
    verified intended slide. Failure injects private-shaped writer JSON, corrupted SVG,
    missing PNG, expired session, revision gap and both channels closing; snapshots show
    explicit public failure/RECOVERING and no wrong slide, while gateway rejects malformed
    receipt. Evidence `<attemptDir>/task-15/{receipt.http,visible.png,bad-asset.png,
    reconnect.log,cleanup.txt}`.
  - Recommended task executor category: `deep-low` - transport parity and visible state
    require cross-module reasoning; browser QA still belongs to this task.
  - Commit: N unless separately requested; draft subject `fix(stage): verify visible slides and narrow receipts`.

- [ ] 16. Reset private Console state across account and deck transitions
  - Closes: GAP-10; Wave C, blocked by 1; blocks 22.
  - References: `apps/console/src/auth-session.tsx:62-80,120-133`,
    `apps/console/src/workspace-page.tsx:40-42,89-103,208-217`,
    `apps/console/src/App.test.tsx`.
  - Acceptance: on successful sign-out clear `activePresentation`, binding, coaching/audio
    and any old pending display handle before B signs in; on account switch never show A's
    private deck. New deck/session identity resets preview index to its first slide and
    lease/revision to its first valid value without resetting an ongoing same-deck talk.
    On sign-out HTTP failure retain A's authenticated session and honest error, not half
    clear controls.
  - QA: happy `bun test apps/console/src/App.test.tsx` exits 0 and real A -> sign-out
    -> B browser flow sees no A title/slide or connection; new shorter deck starts on
    slide 1. Failure sign-out 503, stale network response and shorter deck preserve
    proper owner isolation and no out-of-range preview. Evidence
    `<attemptDir>/task-16/{red.log,green.log,account-b.png,short-deck.png,cleanup.txt}`.
  - Recommended task executor category: `deep-low` - identity changes and async stale
    responses cross the private UI lifecycle.
  - Commit: N unless separately requested; draft subject `fix(console): clear stale account and deck state`.

- [ ] 17. Make references and image-only OCR readiness truthful
  - Closes: GAP-12; Wave C, blocked by 3; blocks 19/20/22.
  - References: `apps/console/src/reference-documents-panel.tsx:23-32,67-78`,
    `apps/console/src/evidence-preparation-panel.tsx:129-165`,
    `services/ingestion/src/impromptu_ingestion/adapters/pdf.py:68-87`,
    `services/private-backend/src/http/routes/deck-uploads.ts:41-67`,
    `services/ingestion/tests/test_adapters.py:307-324`.
  - Acceptance: keep intentional OCR-unavailable image-only upload behavior for a deck
    whose pages can render, but carry a typed `ocr_unavailable` readiness warning into
    the private upload result and Console; mark such pages unsearchable until indexable
    evidence exists. Hard encrypted/unrenderable inputs still reject. Distinguish an empty
    reference list from a failed list load and offer retry. Translate known backend
    errors into Korean/English action text without rendering raw server reason strings;
    unknown errors receive one generic private explanation.
  - QA: happy `uv run --project services/ingestion pytest
    services/ingestion/tests/test_adapters.py -k ocr` and
    `bun test apps/console/src/deck-upload.test.tsx
    services/private-backend/test/deck-upload-http.test.ts
    services/private-backend/test/reference-documents-http.test.ts` exit 0; browser scanned
    PDF without Tesseract shows a rendered slide plus explicit evidence-unavailable warning.
    Failure encrypted PDF returns typed 4xx, reference list 503 shows retry, and a backend
    error sentinel never appears in visible Console text. Evidence
    `<attemptDir>/task-17/{ocr.log,upload.http,warning.png,list-error.png,cleanup.txt}`.
  - Recommended task executor category: `deep-low` - Python warning to TypeScript
    transport/UI is one cross-domain contract.
  - Commit: N unless separately requested; draft subject `fix(console): expose reference and OCR readiness`.

- [ ] 18. Carry observed coaching timing into the durable owner report
  - Closes: GAP-9; Wave C, blocked by 10; blocks 22.
  - References: `services/private-backend/src/bootstrap/audio.ts:47-59`,
    `services/private-backend/src/report/session-report-finalizer.ts:123-236`,
    `services/private-backend/src/report/final-transcript-aggregate.ts:6-17`,
    `apps/console/src/presentation-report.tsx:42-199`,
    `services/private-backend/test/session-report-finalizer.test.ts:181-280`.
  - Acceptance: per-session FINAL timing/coaching event feeds `recordFinal` exactly once;
    neutral pace/cue aggregate in final report matches the observed opt-in readout.
    If no timing capability or coaching off, report states measurement unavailable rather
    than fabricated `0` or stale values from a prior presentation. Preserve idempotent
    report finalization across restart.
  - QA: happy `bun test services/private-backend/test/session-report-finalizer.test.ts
    services/private-backend/test/audio-ingest-http.test.ts
    apps/console/src/presentation-report.test.tsx` exits 0; real capture then
    `GET /v1/presentation-sessions/<id>/report` with owner cookie shows matching aggregate.
    Failure no word timing, duplicated FINAL, restart and B's cookie yield unavailable,
    one count and 403 respectively. Evidence
    `<attemptDir>/task-18/{report.http,report.png,negative.log,cleanup.txt}`.
  - Recommended task executor category: `deep-low` - reconciliation of streamed
    timing and durable aggregation must follow existing identity rules.
  - Commit: N unless separately requested; draft subject `fix(private): persist coaching report aggregates`.

- [ ] 19. Measure recommendation usefulness and latency on the final service tree
  - Closes: GAP-6 and audits GAP-8/15/17 impact; Wave D, blocked by 3,9,10,17; blocks 23.
  - References: `docs/DEMO-SCOPE.md:40-51,83-102,169-172`,
    `.omo/evidence/task-50/final-state.json`,
    `.omo/evidence/task-53/receipts.json`,
    `services/private-backend/src/verifier/recommendation-orchestrator.ts:92-275`,
    `scripts/run-wp9-validation.ts`.
  - Acceptance: freeze the tested tree and representative deck/provider profile; run
    the repository's real-provider positive, negative and confirmed-FINAL acceptance
    cohorts at the documented 5,000 ms budget, recording every run including abstentions
    and deadlines. Add `scripts/run-recommendation-acceptance.ts` if the current
    `tests/e2e/five-features.runner.ts` lacks a machine-readable 10-run cohort mode;
    it invokes that runner against the existing frozen corpus, keeps all failures in
    the denominator and writes one JSON receipt. Require both 10/10 recommendation cohorts within p95 <=5,000 ms,
    direct top-3 usefulness >=80%, supported yield >=60%, unanswerable abstention >=95%,
    and zero critical entity/date/number/privacy escapes on the preregistered corpus.
    Never combine isolated and saturated runs into a fake 10/10. If the currently approved
    provider cannot meet a gate, record FAIL, preserve the verifier and 5-second bound,
    and request a separate owner choice about budget/provider; do not mark the ideal done.
  - QA: happy `bun run test:wp9` and
    `FIVE_FEATURES_RESULT_PATH=<attemptDir>/task-19/core5.json bun run
    tests/e2e/five-features.runner.ts` plus `bun run
    scripts/run-recommendation-acceptance.ts --output
    <attemptDir>/task-19/cohorts.json` exit 0 with all counted verdicts in a JSON receipt,
    and the Console renders eligible advice before deadline. Failure unavailable provider,
    answerable abstention, unsupported number and saturated response remain denominator
    failures, not 200-success cases. Evidence
    `<attemptDir>/task-19/{cohorts.json,acceptance.log,console.png,cleanup.txt}`.
  - Recommended task executor category: `deep-low` - diagnosing a measured provider
    quality/latency shortfall requires evidence rather than a new paid integration.
  - Commit: N if current tree passes; any verified code fix is a separate atomic
    increment with its own tests and receipt before re-running this task.

- [ ] 20. Repair browser-runtime accessibility coverage and retest Console UX
  - Closes: GAP-1, GAP-12 UI follow-up, GAP-16; Wave D, blocked by 1,5,12,14,15,17; blocks 23.
  - References: `scripts/verify-browser-runtime.ts:677-721`,
    `docs/accessibility-matrix.md:5-27`,
    `apps/console/DESIGN.md:38-125`,
    `apps/console/src/console.css:1-110`,
    `apps/stage/src/display-page.tsx:80-143`.
  - Acceptance: remove obsolete Stage fullscreen-button action from the checker;
    assert viewport-filling slide-only DOM and published placement outcome instead
    of inventing a replacement control. Actual Windows local browser F11/manual
    fullscreen and placement are exercised by F3, never inferred from headless Chrome.
    Include Console `/sign-in`, `/session`, live cockpit,
    `/reports/:id` and teammate question route using authenticated fixtures; assert
    one main/h1, labels, keyboard focus, forced colors, contrast, reduced motion and
    320 px/200% zoom. Inspect every UX Round 2 criterion C1-C8 from task 1; if any is
    still failing, repair that exact source/test in a new small row before completing 20.
    Update `docs/accessibility-matrix.md` only after the validator actually covers it.
  - QA: happy `bun run check:browser-runtime` exits 0 with screenshots for every listed
    route/state, plus actual owned-browser 1440x900, 1024x768 and 375x812 Korean/English
    screenshots free of blank/overlapping transport. Failure forced-colors, microphone
    denied, long Korean label and keyboard-only recovery remain visibly operable; injected
    missing console route makes the validator fail. Evidence
    `<attemptDir>/task-20/{runtime.log,console-desktop.png,console-mobile.png,
    stage-desktop.png,accessibility.json,cleanup.txt}`.
  - Recommended task executor category: `visual-engineering` - validator correction
    must match actual rendered and assistive surfaces.
  - Commit: N unless separately requested; draft subject `fix(browser): validate current Console and Stage accessibility`.

- [ ] 21. Replace obsolete release claims with the current slide-only venue contract
  - Closes: GAP-3 and clarifies GAP-7; Wave D, blocked by 4,5,15; blocks 23.
  - References: `docs/final-manual-qa.md:5-19,48-111`,
    `docs/DEMO-SCOPE.md:55-74,169-172,235-261`,
    `services/projection-gateway/src/http.ts:397-403`,
    `services/private-backend/src/http/routes/playback-read.ts:11-18`,
    `.omo/evidence/task-53/receipts.json`.
  - Acceptance: rewrite venue steps 5/6 from public card approval/retraction to
    negative card-ingress/private leakage and actual public slide/recovery checks;
    reflect secure invitation and distinct teammate question path. State task-53's
    historical 10/10 measurement at its commit while keeping current-tree and physical
    acceptance unclaimed until tasks 19/F3 pass. Preserve Windows modes, physical 10-run
    sign-off, support/accuracy/latency thresholds and emergency public artifact.
  - QA: happy read the full revised manual QA and compare each executable step to
    current UI/routes, then `bun run check:repo` exits 0; failure grep for a required
    public-card appearance or claim that a prior automated run equals physical
    sign-off finds zero stale assertions. Prose needs no brittle wording test.
    Evidence `<attemptDir>/task-21/{read-review.md,repo-check.log,cleanup.txt}`.
  - Recommended task executor category: `writing` - release prose and operator
    acceptance must be precise, not a code change.
  - Commit: N unless separately requested; draft subject `docs(release): align venue checks with slide-only Stage`.

- [ ] 22. Exercise cross-account, invitation and report integration end to end
  - Closes: GAP-5, GAP-8, GAP-9, GAP-10, GAP-11, GAP-13, GAP-14, GAP-15 across
    boundaries (GAP-12 is closed by 3/17/20/29/30, not here); Wave D, blocked by 7-18;
    blocks 23.
  - References: `tests/e2e/prepared-evidence.test.ts`,
    `tests/e2e/windows-topology.test.ts`,
    `tests/security/release-security.test.ts`,
    `apps/console/src/console-routes.tsx:11-31`,
    `apps/stage/src/stage-routes.tsx:7-18`,
    `services/private-backend/src/http/routes/qa-defense.ts:158-232`.
  - Acceptance: extend the existing E2E/security suite only for gaps it does not
    currently detect: A invites independent Stage and B, B sends a question, A reviews
    and submits post-talk, report eventually finalizes; C and revoked B cannot access
    A, and Stage has zero question/evidence/card bytes throughout. Test invite expiry,
    replay, stale CAS, rebind at slide 3, account switch, two FINAL events, OCR warning,
    receipt malformed body and service restart with tombstones/slide position. Subscribe
    before mutations and use bounded signals, no fixed sleeps. Keep each production
    increment buildable and do not edit an existing correct negative test to pass.
  - QA: happy `bun run test:e2e && bun run test:security && bun run test:db` exits 0
    with authenticated A/B and Stage receipt; manual omowright A/B/C + Stage action log
    matches those identities and final screenshot shows slide 3 and owner-only report.
    Failure B after revoke, C on grant/inbox/report, replay invite, stale receipt and
    malicious Stage payload yield typed denial/zero private pixels. Evidence
    `<attemptDir>/task-22/{e2e.log,security.log,db.log,journey.json,
    stage.png,cleanup.txt}`.
  - Recommended task executor category: `deep-low` - cross-boundary E2E oracles
    must tie roles, epochs and visible effects together.
  - Commit: N unless separately requested; draft subject `test(e2e): prove scoped presentation journeys`.

- [ ] 23. Integrate all increments and prove the release candidate on its real surfaces
  - Closes: GAP-1, GAP-3, GAP-4, GAP-6, GAP-13 and GAP-16 at the final tree; Wave D,
    blocked by 19-22; blocks the 24-41 amendment chain and then F1-F7.
  - References: root `package.json` scripts, `scripts/dev-services.ts:1-83`,
    `docs/final-manual-qa.md`, `apps/console/DESIGN.md`, this plan's `## Success criteria`.
  - Acceptance: run `bun run check` plus `bun run test:e2e`, `bun run test:security`,
    `bun run test:db`, `uv run --project services/ingestion pytest`, and the frozen
    recommendation gate on the integrated tree. Drive actual Console sign-in, upload,
    separate Stage invitation/approval, slide 1 -> 3, teammate question, report,
    sign-out, channel loss and asset error through owned Chrome and Edge profiles.
    Capture status+body, action logs and desktop/mobile screenshots; ensure zero
    private/card pixels on Stage and no stale READY. A failure appends a narrowly
    scoped task, verifies it and re-runs only affected proofs plus final integrated
    run on the new tree. Tear down all servers, profiles, databases and ports.
  - QA: happy above commands all exit 0, exact visible slide and owner-only Q&A/report
    appear in screenshots; failure forged invite, wrong account, malformed payload,
    offline/restart and absent OCR produce expected denial or public-safe state.
    Evidence `<attemptDir>/task-23/{check.log,e2e.log,security.log,db.log,python.log,
    browser-console.png,browser-stage.png,actions.json,negative.http,cleanup.txt}`.
  - Recommended task executor category: `unspecified-high` - final integration
    spans all domains but each decision was settled by earlier rows.
  - Commit: N; only integration evidence, any fix becomes its own verified row.

## Final verification wave
> After all implementation todos, all seven independent checks (F1-F7) must approve; show the results to the user before declaring execution complete.
- [ ] F1. Audit implementation against each plan task and approved decision
  - References: every task 1-41, draft decision ledger, `git diff` and each
    `<attemptDir>/task-N/` receipt. Independent read-only verifier; default executor
    `unspecified-high`.
  - QA: parse all 41 task rows and the completion ledger; PASS only if each has an
    exact-file diff (or, where separately authorized, a merged commit) or a baseline
    no-edit record, happy and failure evidence,
    tests/real-surface proof and cleanup. For malicious counterexample, withhold one
    task's screenshot or original failing reproduction and confirm the audit returns
    FAIL. Evidence `<attemptDir>/final/F1-compliance.md`.

- [ ] F2. Review code quality, security boundaries and the integrated diff
  - References: `apps/stage/AGENTS.md`, `apps/console/AGENTS.md`,
    `services/private-backend/AGENTS.md`, `services/projection-gateway/AGENTS.md`,
    `infra/migrations/private/0012_team_questions.sql`, the task-37 presentation-list
    migration and list artifacts, all changed-file diagnostics.
    Independent reviewer category `deep-high` for cross-package security decisions.
  - QA: `bun run lint && bun run typecheck && bun run check:boundaries &&
    bun run check:browser-boundary && bun run test && bun run build` must exit 0;
    inspect Stage import graph, closed DTOs, invitation one-use race, teammate
    revocation adjacency, migration order, idempotency, and exact changed-file diff.
    A deliberately replayed invite or B reading A's report must reject. Evidence
    `<attemptDir>/final/F2-review.md` and `<attemptDir>/final/F2-check.log`.

- [ ] F3. Independently drive the full real-surface and physical venue QA
  - References: `docs/final-manual-qa.md`, task 23 evidence, `scripts/dev-services.ts`,
    `docs/runbooks/venue-failure-recovery.md`; category `unspecified-high`.
  - QA: on isolated task-owned profiles use omowright Console
    `http://localhost:4173/sign-in` and Stage `http://localhost:4174/` for
    A/B/C, uploader, invitation, binding, playback, Q&A/report and failure
    injections; archive screenshots at desktop/mobile plus HTTP status/headers/body.
    Then on **actual Windows 11 Chrome/Edge, target projector, separate controller**
    perform Extend, Duplicate and single-screen emergency fallback **10 consecutive
    uninterrupted runs**, P0=0, privacy mistakes=0, setup/slide/failure/recovery
    completion=100%, signed by operator and privacy observer with redacted public-only
    photographs. If hardware, observer or approved provider are unavailable, F3
    stays OPEN; local simulation is never PASS. A single private projector pixel or
    failed connection is FAIL. Evidence `<attemptDir>/final/F3-browser/`,
    `<attemptDir>/final/F3-venue/`, `<attemptDir>/final/F3-cleanup.txt`.

- [ ] F4. Compare delivered experience one-to-one with IS-1 through IS-12
  - References: `## Scope` IS/GAP matrix, `## Success criteria`, tasks 1-41 and
    F1-F3 verdicts; independent verifier category `unspecified-high`.
  - QA: for each IS row read the named happy/failure artifact on the **final tree**,
    verify the actual presenter/teammate/audience/venue observable and its cleanup
    receipt, and link all sixteen GAP closures. Reject stale receipts from earlier
    commits, a green HTTP call over blank Stage, good latency with abstention,
    and automated runs masquerading as physical rehearsal. PASS iff all twelve IS
    rows (IS-1..IS-12) and all sixteen gaps are closed and F1-F3 approve; a
    shortfall is a new numbered implementation task, not a note. Evidence
    `<attemptDir>/final/F4-fidelity.md`.

## Commit strategy

Do not create or stage commits unless the execution user explicitly asks for them.
Each task nevertheless includes a proposed reviewable subject. On explicit commit
authorization, `git log --oneline -20` plus `git log -5 -- <touched paths>` determines
scope and message style; stage only exact unit paths, run `git diff --cached --check`,
owner diagnostics/tests and its real scenario, then commit one buildable verified
increment. Never stage `.omo`, evidence screenshots, secrets or concurrent users'
changes. A shared DTO producer/consumer change is one increment; a migration and its
consumer/test land together. Without that separate authorization, leave changes
unstaged and report the draft subjects; baselines and final verification never commit.

## Success criteria

| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| --- | --- | --- | --- |
| IS-1 | 1,3,17,23 | Representative valid/invalid/scanned uploads; reference list 503 and OCR warning in private Console | task-1, task-3, task-17, task-23; F3 |
| IS-2 | 2,6,7,12,13,22,23 | Independent Stage profile accepts invitation; exact fingerprint/CAS binds once; expired/wrong/replayed join rejects | task-2, task-6, task-7, task-12, task-13, task-22; F3 |
| IS-3 | 1,10,16,18,20,23 | Phase controls/capture/coaching, KO/EN, 1440/1024/375 and 320px/200% keyboard/contrast/forced colors | task-1, task-16, task-18, task-20; F3 |
| IS-4 | 2,4,6,7,13,15,22,23 | Public slide pixels verified; malformed receipt/asset fault/revision gap and card ingress do not leak private data | task-4, task-15, task-22, task-23; F3 |
| IS-5 | 4,8,9,10,14,19,22,23 | A/B/C grants, private question draft, grounded answer/abstention, revoke and Stage zero bytes | task-8, task-9, task-10, task-14, task-19, task-22; F3 |
| IS-6 | 1,11,16,18,22,23 | PENDING becomes FINALIZED, persisted coaching/slide labels/Q&A survive reload; nonowner denied | task-11, task-18, task-22; F3 |
| IS-7 | 2,9,10,11,15,16,17,20,22,23 | Expiry, denial, error, OCR unavailable, bad asset and reconnect show truthful bounded recovery | task-9, task-10, task-15, task-17, task-22; F3 |
| IS-8 | 4,5,19,20,21,22,23,24-41,F1-F7 | Current-tree build/security/browser proof plus signed 10-run real Windows venue record | task-19 through task-23; F1-F4 |


## Scope > Affected user and ideal state — commercial amendment

2026-09-27 추가 요청을 반영한 단일 실행 계획이다. 위 1-23번과 기존 IS-1..IS-8,
GAP-1..GAP-16은 유지하며, 아래 24-41번은 고객 언어·동선·재방문 경험을 구체화한다.
겹치는 구현은 한 번만 수행한다. 아래 의존표의 기존 작업 결과를 재사용하고 추가 UI/계약 차이만
구현한다. 앞부분의 고객 문구나 제품 동선이 아래 상세안과 다르면 아래 상세안을 적용하되,
private/public 분리·권한·현장 QA 요구는 완화하지 않는다. 모든 작업은 미실행이다.

| ID | 영향받는 사용자 | 관찰 가능한 이상 상태 |
| --- | --- | --- |
| IS-9 | 처음 접속한 발표자 | 내부 용어를 배우지 않고 로그인, 자료 준비, 발표 화면 연결, 발표, 질의응답, 결과 확인을 마친다. |
| IS-10 | 발표자·팀원·청중 | 화면 문구가 실제 권한/기능과 일치하고, 자료·답변·출처·검증·권리를 혼동하지 않는다. 청중은 슬라이드만 본다. |
| IS-11 | 다시 접속한 발표자 | 다른 기기나 새 브라우저에서도 자기 발표와 결과를 찾고, 다른 계정의 항목은 볼 수 없다. |
| IS-12 | 운영자·사용자 | 공개 버튼이 실제 배포 origin으로 연결되고, 오류·마이크·AI 상태와 고객 안내가 실제 동작과 일치한다. |

## Success criteria — IS to todo to QA

아래 표는 기존 기준에 이번 제품 요구를 연결한다. 기존 작업의 상세 source path:line,
정상/실패 증거 경로와 아래 Q 행을 함께 적용한다. 신규 증거 루트는
`.omo/evidence/product-experience/`다. Qxx의 정상/실패 파일은
`task-40/Qxx-happy.json`, `task-40/Qxx-failure.json`이며 절대적인 전체 경로는
해당 루트에 붙인다. 추가 작업의 증거 디렉터리도 전역 작업 번호 24-41을 사용한다.
기존 작업 1-23의 `<attemptDir>/task-N/`과 번호가 겹치지 않는다(24-41 사용).

| IS | 구현 todo | 정상 / 실패 QA | 최종 검토 |
| --- | --- | --- | --- |
| IS-1 | 1,3,17,24,30 | Q02,Q03,Q07: 실제 준비 / OCR·검색 실패·미설정 | F3,F6 |
| IS-2 | 2,6,7,12,13,31,32 | Q04,Q05,Q06: 두 기기 실제 연결 / 만료·재사용·CAS | F1,F3,F5 |
| IS-3 | 1,10,16,18,20,26,27,30,33,38 | Q01,Q08,Q12: 정상 동선 / 계정전환·권한거부·좁은 화면 | F3,F6 |
| IS-4 | 4,15,22,33 | Q06,Q13: 검증된 실제 슬라이드 / asset·private 정보·stale 실패 | F1,F3,F5 |
| IS-5 | 8,9,10,14,19,34,35 | Q07,Q08,Q09: 검토한 질문·출처 / abstention·권한철회 | F1,F3,F5 |
| IS-6 | 11,18,22,36,37 | Q10,Q11: 최종 결과 재진입 / PENDING·v1·비소유자 | F3,F6 |
| IS-7 | 9,10,11,15,16,17,30,32,33,34,36 | Q02,Q04,Q06,Q07,Q08,Q10: 복구 / 실패 원인 구분 | F2,F3,F6 |
| IS-8 | 4,5,19,20,21,22,23,38,39,40,41 | Q12-Q15 및 기존 현장 10회: 실제 브라우저 / 실제 장비 실패 | F1-F7 |
| IS-9 | 24,25,26,27,28,30,32,33,36 | Q01-Q06,Q10: 첫 사용 완주 / 막힌 CTA·옛 링크 | F4,F6 |
| IS-10 | 25,28,29,34,35,38,41 | Q07,Q09,Q12,Q13: 문맥별 의미 / raw 오류·권한 오인·private 유출 | F4,F5,F6 |
| IS-11 | 16,11,18,37 | Q01,Q10,Q11: 자기 발표 복원 / 계정 전환·서버 재시작 | F3,F4,F7 |
| IS-12 | 19,20,21,23,34,39,40,41 | Q07,Q08,Q14,Q15: 실제 설정 일치 / stale origin·마이크·장비 | F2,F3,F7 |

### Inherited GAP coverage

| GAP | 기존 구현 유지 | 추가/통합 todo | 정상 / 실패 QA |
| --- | --- | --- | --- |
| GAP-1 | 1,20,23 | 24,38,40 | Q01,Q12; C1-C8 기존 행도 유지 |
| GAP-2 | 2,6,7,12,13 | 31,32 | Q04,Q05 |
| GAP-3 | 4,21,23 | 28,41 | Q13 및 옛 승인 URL 복귀 |
| GAP-4 | 2,15,23 | 32,33 | Q04,Q06; HTTP receipt narrowing 기존 검증 유지 |
| GAP-5 | 4,8,14,22 | 35 | Q09 |
| GAP-6 | 3,19,23 | 34,40 | Q07; 기존 최종 트리 10회 측정 유지 |
| GAP-7 | F3,F4 | 40,F7 | Q15; 실제 Windows 현장 10회 기록 |
| GAP-8 | 9,22 | 34 | Q08; 기존 작업 9의 호출별 STT deadline 정상/실패 |
| GAP-9 | 10,18,22 | 36 | Q08,Q10; 실제 coaching 저장/재조회 |
| GAP-10 | 1,16,22 | 33,37 | Q01,Q06,Q11 |
| GAP-11 | 2,7,12,22 | 31,32 | Q04,Q06 |
| GAP-12 | 3,17,20 | 29,30 | Q02,Q03,Q07 |
| GAP-13 | 2,15,23 | 33 | Q06,Q13 |
| GAP-14 | 11,22 | 36 | Q10 |
| GAP-15 | 3,10,22 | 34 | Q08; 기존 두 FINAL 이벤트 head-of-line 검증 유지 |
| GAP-16 | 5,20,23 | 38,40 | Q12,Q14 |

### Cross-plan dependency matrix

| 추가 작업 | 재사용할 기존 완료 조건 | 추가 책임 |
| --- | --- | --- |
| 24-26 | 1-5 | 사용자 문구 인벤토리·화면 상태 기준 |
| 27-30 | 16,17,20의 변경과 조정 | 인증·폐기 동선·문구·준비 상태 |
| 31 | 6,7 | 초대 계약에 대한 제품 흐름 차이만 반영 |
| 32 | 12,13,31 | 같은/다른 기기 UI 통합 |
| 33 | 15,16,32 | 실제 렌더·복구와 발표 UI 연결 |
| 34 | 9,10,19,30 | STT/연속 FINAL/모델 상태 사실과 UI 일치 |
| 35 | 8,14,34 | 질문 전용 팀원 UX |
| 36 | 11,18,22,33,34,35 | Q&A/결과 통합; 기존 데이터 호환 |
| 37 | 16,36 | 신규 내 발표 목록/소유자 재진입 |
| 38-41 | 20,21,22,23 및 앞선 추가 작업 | 최종 통합 검증과 고객 안내 |
| F1-F7 | 1-41 | 보강까지 포함한 최종 트리에서 판정 |

### 추가 작업의 소스 시작점

아래 위치는 현행 코드에서 확인한 시작점이다. 새 경로나 테이블이 이미 존재한다는
뜻은 아니며, line 범위는 dirty tree 기준이므로 구현 시 마지막 통합 트리에서 다시
확인한다. `[data-transport-strip]` 등 일부 selector는 아직 DOM에 없을 수 있으며,
Wave A 기준선은 발견한 부재를 FAIL로 기록하고 존재를 꾸며내지 않는다.
`unspecified-low`/`unspecified-high` 카테고리는 디스패처가 해당 레인을 지원하지
않으면 `deep-low`로 매핑한다. 정상/실패 인수 시나리오와
증거 경로는 각 작업의 QA 및 7.2절 Q01-Q15에 연결한다.

| 작업 | 기존 소스 시작점 | 작업 | 기존 소스 시작점 |
| --- | --- | --- | --- |
| 24 | `apps/console/src/workspace-page.tsx:55-68,183-236` | 25 | `apps/console/src/locales/ko.json:1-47` |
| 26 | `apps/console/DESIGN.md:1-51` | 27 | `apps/console/src/auth-pages.tsx:26-73` |
| 28 | `apps/console/src/private-shell.tsx:15-25` | 29 | `apps/console/src/evidence-card.tsx:28-52` |
| 30 | `apps/console/src/reference-documents-panel.tsx:50-78` | 31 | `apps/console/src/display-playback.ts:48-76` |
| 32 | `apps/console/src/audience-panel.tsx:63-140` | 33 | `apps/stage/src/display-page.tsx:80-136` |
| 34 | `apps/console/src/qa-defense-panel.tsx:110-165` | 35 | `services/private-backend/src/http/routes/coordinator-commands.ts:142-154` |
| 36 | `apps/console/src/report-page.tsx:21-92` | 37 | `apps/console/src/console-routes.tsx:14-32` |
| 38 | `apps/console/src/locale-parity.test.ts:1-10` | 39 | `apps/console/src/stage-origin.ts:7-10` |
| 40 | `apps/stage/src/stage-routes.tsx:8-18` | 41 | `docs/DEMO-SCOPE.md:19-30` |

### Reviewer follow-up and architecture clarifications

- 초대에는 128비트 이상 난수 token을 쓰고 저장소에는 digest만 저장한다. 90초 이내 TTL과
  일회 소비는 서버에서 원자적으로 보장하며 재시작 후에도 재사용을 거절한다.
- 초대 token은 query 대신 URL fragment에 싣고, 부트스트랩이 모듈/추가 요청보다 먼저
  읽어 메모리에만 보관하고 `history.replaceState`로 지운다. 기존 계획의 query 예시는 이
  규칙으로 대체한다. 초대 페이지와 관련 응답은 no-store; SW/분석/로그에 token을 남기지 않는다.
- 전역 no-referrer와 mutation의 Referer 필수 검사를 충돌시키지 않는다. URL 정리 후
  동일 origin API 호출에 한해 `referrerPolicy: "same-origin"`을 명시하고 실제 브라우저에서
  깨끗한 Stage Referer가 전송되는지 검증한다. 서버 Origin/Referer 검사 완화는 금지한다.
- Stage의 /v1, SSE, WSS는 Stage와 같은 origin의 프록시로 유지한다. Console이 현재의
  `발표 화면 열기` 클릭으로 연 정확한 창은 그 클릭과 opener/source/origin 검증을 기존
  승인 제스처로 취급할 수 있다. 별도 기기 초대 링크는 소지만으로 자동 승인하지 않으며
  화면에 표시된 대상과 최신 epoch에 대한 별도의 발표자 승인을 요구한다.
- gateway 기존 snapshot은 closed parsing 계약이므로 초대 상태는 별도 버전 key/추가 테이블에
  저장한다. 기존 snapshot에 임의 필드를 추가하지 않는다. 이전 binary 복원 가능성을 테스트한다.
- bare Stage는 안내만 하고 계정 로그인이나 무권한 자동 연결은 만들지 않는다. fingerprint는
  이번 join 식별자이지 영구 장치 인증이 아니다.
- 팀원 grant의 종료 조건은 기존 승인 계약을 따른다. 발표 세션 종료·철회 후 거절을 유지하고
  post-talk 질문 수집은 기존 Q&A 허용 상태에 한정한다. 슬라이드 진행 종료와 권한 종료를
  동일하게 이름 붙여 재접속 권한을 부활시키지 않는다.

# Commercial product experience amendment — 2026-09-27

작성: 2026-09-27. 기준: HEAD `3d99719`와 현재 작업 트리.
상태: 구현 전 제안. 이 문서 작성은 코드 변경·배포·구매 승인이 아니다.
검토 기록: `.omo/drafts/impromptu-ideal-experience.md`.

## TL;DR (For humans)

**권고:** Stage라는 두 번째 제품을 사용자에게 설명하지 않는다. Impromptu 안에서
`발표 화면 열기`를 누르면 청중용 창이 열리도록 한다. 다만 그 창은 지금처럼
발표자 화면과 다른 origin, 빌드, 쿠키, 서비스 워커, 공개 API를 사용한다.

현재 어색함의 원인은 맞춤법만이 아니다. `비공개`, `제어`, `근거`, `승인`, `세션`
같은 내부 시스템의 구분이 사용자의 작업 이름이 되었다. 이를
`자료 준비 -> 화면 연결 -> 발표 -> 질의응답 -> 발표 결과`로 재구성한다.

- 발표자가 배우는 제품 이름은 Impromptu 하나다.
- `근거`를 일괄적으로 `참고 자료`로 바꾸지 않는다. 업로드 문서, 추천 내용, 답변 출처,
  검증 여부, 사용 권한을 구분한다.
- 사용자가 수행할 수 없는 공개 카드 승인 메뉴는 고객 동선에서 제거한다.
- 화면 이름을 바꾸는 작업과 저장된 데이터 형식을 바꾸는 작업을 분리한다.
- AI·코칭·팀원 기능은 실제 준비 상태와 권한에 맞게 표시한다.
- 발표자가 다시 접속했을 때 자신의 자료와 결과를 찾는 흐름까지 제품의 범위로 본다.

**하지 않을 일:** 전체 백엔드 재작성, Stage를 private 앱에 합치기, 공개 AI 답변 게시,
모델 제공자 교체, 결제·요금제·SSO·공동 문서 편집 추가, 기존 보고서 일괄 변환.
판매 제품처럼 만든다는 말이 곧 결제 시스템을 먼저 만든다는 뜻은 아니다.

## 1. 확인된 사실과 제안의 경계

### 1.1 실제 확인한 내용

| ID | 현재 사실 | 근거 |
| --- | --- | --- |
| E01 | 로그인 제목은 `비공개 발표 제어`, 버튼은 `비공개 워크스페이스 입장`이다. | `apps/console/src/locales/ko.json:75-81`, `auth-pages.tsx:27-72` |
| E02 | Console 루트와 `/session`은 같은 작업 화면이다. `/live-publication`과 `/reports/:presentationSessionId`가 별도 경로다. | `apps/console/src/console-routes.tsx:14-33` |
| E03 | Stage는 이미 별도 앱이며 `/`와 `/display/:displayId`를 제공한다. 단순히 Console의 `/stage` 탭인 것이 아니다. | `apps/stage/src/stage-routes.tsx:7-20` |
| E04 | Stage 직접 진입은 opener가 없으면 join 생성도 하지 않는다. | `apps/stage/src/landing-page.tsx:20-38,139-145` |
| E05 | Console에는 링크 복사와 다른 기기 연결 코드 입력 UI가 남아 있다. | `apps/console/src/audience-panel.tsx:66-70,95-145` |
| E06 | 고객 내비게이션에 공개 `근거 승인` 진입점이 있다. 해당 공개 승인/종료 API는 410을 반환한다. | `apps/console/src/private-shell.tsx:18-25`, `services/private-backend/src/http/routes/playback-read.ts:11-18` |
| E07 | Gateway의 공개 카드 수신도 차단되어 있다. | `services/projection-gateway/src/http.ts:397-403` |
| E08 | `준비된 근거`가 단순 번역 문자열뿐 아니라 보고서 DTO와 파서의 고정값이다. | `services/private-backend/src/report/session-report-dto.ts:20-23,76-84`, `apps/console/src/session-report-view.ts:36-38,136-138` |
| E09 | 보고서 화면의 제목은 이미 번역 계층에서 별도로 전달할 수 있다. | `apps/console/src/presentation-report-text.ts:81-88`, `presentation-report.tsx:148-179` |
| E10 | 발표 종료는 보고서로 이동하고, 질의응답은 보고서 뒤에 붙어 있다. | `apps/console/src/playback-panel.tsx:151-186`, `report-page.tsx:95-106`, `qa-defense-panel.tsx:13-17` |
| E11 | Stage 관련 문구에는 공개 근거 카드 설명이 남아 있으나 현재 호출부가 확인되지 않는 키도 있다. | `apps/stage/src/locales/ko.json:12-18`; 키별 호출 검색 필요 |
| E12 | `청RE중`, `코칭 표시 음소거`, `조각 색인됨`, `마지막 현재 속도`, `파생 집계`가 카탈로그에 있다. | `apps/console/src/locales/ko.json:17,43,121,185-194` |
| E13 | HTTPS 계정 쿠키와 display 쿠키가 각각 host 전용 이름을 쓰며 `Path=/`, HttpOnly, Secure, SameSite=Strict를 사용한다. | `services/private-backend/src/http/session-cookies.ts:4-10`, `services/projection-gateway/src/display-session-cookie.ts:11-19` |
| E14 | 브라우저에 들어가는 Stage origin은 빌드 시점 환경변수다. | `apps/console/src/stage-origin.ts:7-10`, `compose.production.yaml:165-166` |
| E15 | 내 발표 목록용 화면은 현재 라우트 목록에 없다. 발표/결과 목록을 제공하려면 저장·조회 범위를 추가해야 한다. | `apps/console/src/console-routes.tsx:14-33` |
| E16 | 출처 종류(INTERNAL/EXTERNAL)가 현재 카드의 승인/권리 배지 선택과 연결된다. 이를 답변 사실 검증으로 읽게 해서는 안 된다. | `apps/console/src/evidence-card.tsx:28-39` |

2026-09-27에 배포된 로그인 화면을 1365x900과 390x844에서 직접 열어 E01을 확인했다.
Stage 루트도 1365x768에서 직접 열었고 `청중 화면은 발표자 콘솔에서 열립니다.`만 보였다.
인증된 내부 화면의 모든 상태나 실제 프로젝터를 이번 조사에서 재검증한 것은 아니다.
소스 사실, 과거 배포 검증, 이번 읽기 전용 화면 관찰, 앞으로의 인수 검사를 혼동하지 않는다.

### 1.2 기존 계획과의 관계

`.omo/plans/impromptu-ideal-experience.md`의 보안·권한·복구 결정을 유지한다.
이미 승인된 단기 비권한성 초대와 별도 인증된 질문 전용 팀원 접근을 다시 임의로 바꾸지 않는다.
이 계획은 기존 계획의 사용자 이름·정보 구조·화면 순서 부분을 구체화한다.
기존 23개 작업이 구현됐다는 의미는 아니다.

- 초대/연결: 기존 작업 6, 7, 12, 13, 15와 아래 작업 31-33을 하나의 구현 단위로 조정한다.
- 팀원: 기존 작업 8, 14와 아래 작업 35를 연결한다.
- 자료/AI/코칭: 기존 작업 9, 10, 17-19와 아래 작업 30, 34을 연결한다.
- 보고서: 기존 작업 11, 18과 아래 작업 36을 연결한다.
- 회귀/접근성/출시: 기존 작업 16, 20-23과 아래 작업 38-41을 연결한다.
- 이미 구현된 내용은 현재 트리의 동작으로 증명한 뒤 재사용한다. 같은 기능을 두 번 만들지 않는다.

### 1.3 이번에 채택한 가정

| 항목 | 계획의 기본값 | 변경/승인 경계 |
| --- | --- | --- |
| 핵심 사용자 | 자료를 준비하고 발표하며 질문에 답하는 발표자, 질문을 돕는 팀원 | 새로운 시장·직군 독점 타깃을 확정하지 않는다. |
| 제품 약속 | 발표 자료를 보면서 발표하고, 질문에 답할 때 관련 자료를 찾도록 돕는다. | `어떤 질문이든 정확히 답한다`고 약속하지 않는다. |
| 기술 | 현재 Next/React, Stage, Bun 서비스와 DB 분리를 유지 | 프레임워크 이전 없음 |
| 배포 | 하나의 고객 진입점, 공개 출력은 별도 origin | 유료 도메인/인프라 구매는 실행 중 별도 승인 |
| 언어 | 한국어 기준 문장 + 동등한 영어 의미 | 영어 직역을 한국어 문법의 기준으로 쓰지 않는다. |
| 규모 | 기존 발표 세션 단위 | 새로운 동시접속/SLA 수치를 가정하지 않는다. |
| 개인정보 | 현재 저장·전송 사실만 안내 | 보존기간·규정 준수·삭제 보장을 임의로 만들지 않는다. |

## 2. Stage를 어떻게 다룰 것인가

### 2.1 세 가지 질문을 분리한다

1. **청중에게 보여 줄 별도 화면이 필요한가?** 이 제품에서 슬라이드를 송출하려면 필요하다.
2. **그 화면을 별도 보안 영역에 둘 이유가 있는가?** 현재 설계에는 분명히 있다.
3. **사용자가 Stage라는 이름과 별도 서비스 주소를 알아야 하는가?** 그럴 필요는 없다.

따라서 없앨 대상은 별도 화면 자체보다 **그 화면을 설정하는 시스템 구조의 노출**이다.
기술 모듈명 `apps/stage`와 고객에게 보이는 이름 `발표 화면`은 달라도 된다.

### 2.2 대안 비교

| 대안 | 얻는 것 | 잃는 것/추가 작업 | 판단 |
| --- | --- | --- | --- |
| Stage 폐지, 발표자가 기존 PPT만 송출 | 제품 내 출력 동선 축소 | 동기화·슬라이드 표시·연결 복구를 제품에서 포기하거나 외부 연동을 새로 만들어야 함 | 제품 범위 재정의이므로 현재 기본안 아님 |
| 같은 origin의 `/stage`로 통합 | 주소와 배포 외형 단순화 | 현재 host 쿠키·저장소·SW·BFF 경계 재설계 및 전체 보안 검증 필요 | 이 요청의 비용 대비 이익이 작음 |
| 별도 origin, 단일 제품 진입점 | 기존 경계 유지, 사용자 경험 단순화 | 초대/연결 동선 완성과 정확한 운영 설정 필요 | **권고** |

같은 origin 구현이 원리적으로 불가능하다는 뜻은 아니다. 다만 path는 브라우저의
보안 경계가 아니며, CSS로 private 패널을 숨기는 것은 권한 분리가 아니다.
두 subdomain도 같은 site일 수 있으므로 SameSite만 믿지 않는다.
host-only 쿠키, 정확한 origin 검사, CSRF, 분리된 API 라우팅을 함께 유지한다.

### 2.3 권고 구조

```text
고객 진입점: Impromptu
  로그인 -> 내 발표 -> 자료 준비 -> 발표자 화면 -> 질의응답/발표 결과
                  |
                  +-- "발표 화면 열기"
                         |
                         v
                  별도 origin의 공개 출력
                  대기 -> 화면 연결 -> 검증된 슬라이드

발표자 브라우저 -> private BFF -> private backend -> private DB
                                              |
                                     공개용 데이터만 전달
                                              v
발표 화면 -> public BFF/WSS -> projection gateway -> public projection DB
```

도메인 예시는 `app.<소유 도메인>`과 `present.<소유 도메인>`이다.
이는 구매하거나 DNS를 변경하라는 지시가 아니다. 실제 값을 확보하기 전에는 기존 origin을 쓴다.
내부 서비스명, DB, API 경로를 고객 용어 변경 때문에 함께 바꾸지 않는다.
Stage의 `/display/:displayId`도 유지한다. 모듈/URL 이름 변경 자체는 고객 가치가 작다.

### 2.4 화면 연결의 완료 정의

사용자에게 보이는 단계는 `발표 화면 열기 -> 같은 화면인지 확인 -> 연결`이다.
내부 처리는 다음 순서를 따른다.

1. 인증된 발표자가 현재 자료에 대해 최대 90초, 일회용, 비권한성 초대를 만든다.
2. 같은 기기 창 또는 다른 기기의 공개 화면이 이를 자기 join으로 교환한다.
3. 두 화면에 같은 식별 정보를 표시한다. 코드와 초대 링크는 최종 display 권한이 아니다.
4. 발표자가 표시된 대상과 현재 자료를 확인하고 `이 화면 연결`을 누른다.
5. 서버는 최신 binding epoch, deck version, display ID/fingerprint를 검증해 바인딩한다.
6. 공개 화면이 자기 host의 display 쿠키를 발급받아 snapshot을 읽는다.
7. 실제 슬라이드 검증·렌더 확인 후 `연결됨`을 보여 준다. 요청 201/202만으로 완료 처리하지 않는다.

오래된 코드·초대 재사용·다른 계정·자료 교체·두 탭 동시 승인·팝업 차단·opener 없음은
각각 분리된 실패/복구 상태다. `window.opener`는 편의 신호이지 권한이나 유일한 진입 조건이 아니다.
초대 교환 후 URL에서 민감한 locator를 제거하고 로그·분석 이벤트·Referrer로 전파하지 않는다.
소유자 쿠키/CSRF/로그인 토큰을 Stage URL이나 postMessage에 넣지 않는다.

`연결 해제`는 서버 display 세션을 철회한다. `발표 중단`·`발표 종료`와 다른 작업이다.
전체 화면 전환과 화면 배치는 공개 화면에서 직접 누른 동작이어야 한다.
한 화면만 있을 때 private 창을 전체 화면으로 만드는 fallback은 제공하지 않는다.
복제 화면에서는 별도 제어 기기를 안내하고, 확장 화면에서는 공개 창만 프로젝터로 옮긴다.

## 3. 제품 개념과 이름

### 3.1 고객이 알아야 하는 개념

| 개념 | 의미 | 혼동하지 않을 것 |
| --- | --- | --- |
| 발표 | 사용자가 다시 찾아올 작업 단위 | 서버 세션 토큰 |
| 발표 자료 | 송출할 PPTX/PDF | 참고 문서 |
| 참고 자료 | 답변을 찾을 때 참고하는 추가 문서 | 이미 검증된 답변 |
| 발표자 화면 | 슬라이드 제어와 개인 도움말 | 청중에게 보이는 출력 |
| 발표 화면 | 청중에게 보여 주는 슬라이드 창 | 공개 링크를 통한 무권한 조회 |
| 관련 자료 | 현재 슬라이드와 관련해 찾은 내용 | 발표자가 실제 사용한 자료 |
| 답변 제안 | 자료를 바탕으로 작성한 초안 | 사실성이 보증된 정답 |
| 출처 | 답변에 사용된 문서·슬라이드의 위치 | 문서 사용 권한 |
| 발표 결과 | 발표 시간, 기록된 질문, 관측된 지표 | AI가 임의로 만든 평가 점수 |

`근거`는 자연스러운 설명 문장이나 사용자가 작성한 질문에는 쓸 수 있다.
탭·기능 이름으로 남발하지 않는다. `근거 부족`과 `서버 장애`도 같은 문구로 묶지 않는다.

### 3.2 용어 교체표

| 현재 문구 | 권고 문구/처리 | 이유 |
| --- | --- | --- |
| 비공개 발표 제어 | Impromptu에 로그인 | 사용자의 현재 행동 |
| 비공개 워크스페이스 입장 | 로그인 | 익숙한 동사 |
| 발표자 계정 만들기 | 계정 만들기 | 역할은 이후 권한으로 구분 |
| 사용자 이름 | 아이디 | 현재는 실명이나 이메일이 아닌 username 인증 |
| 발표 워크스페이스 | 발표 준비 / 발표자 화면 | 현재 단계에 맞춤 |
| 워크스페이스 나가기 | 로그아웃 | 실제 signOut 동작과 일치 |
| 발표자 콘솔 | 발표자 화면 | 내부 도구 느낌 제거 |
| Stage / 청중 화면 | 발표 화면 | 사용자 버튼에서 일관되게 사용 |
| 근거 승인 | 고객 내비게이션에서 제거 | 현재 공개 카드 API가 비활성 |
| 실시간 근거 승인 | 고객 화면에서 제거 | 이름만 바꿔 막힌 기능을 유지하지 않음 |
| 준비된 근거 | 관련 자료 | 준비/발표 화면의 추천 목록 |
| 준비된 근거 | 참고한 자료가 아닌 `관련 자료` | 실제 사용 추적이 없으므로 사용했다고 단정 금지 |
| 근거를 백그라운드에서 찾고 있습니다 | 현재 슬라이드와 관련된 자료를 찾고 있습니다. | 목적을 설명 |
| 내부 근거 · 승인됨(APPROVED) | 업로드한 자료 | 출처 종류와 사실 검증을 구분 |
| 권리 미확인(UNKNOWN) | 이용 조건 확인 필요 | 권리 상태를 설명, 정확성 보장 아님 |
| 출처 URL | 원문 보기 | 행동 중심 링크; URL은 상세정보에서 복사 |
| 색인하는 중 | 검색할 수 있도록 자료를 정리하고 있습니다. | 내부 처리명 제거 |
| 자료 {count}개를 색인했습니다 | 참고 자료 {count}개를 사용할 수 있습니다. | 성공한 문서에만 사용 |
| {count}개 조각 색인됨 | 분석 완료 | chunk 개수는 고객 기본 정보에서 제외 |
| 추출된 텍스트 없음 | 문서에서 읽을 수 있는 내용을 찾지 못했습니다. | 원인·대안 안내 연결 |
| 명시적 승인 전송 중 | 고객에게 표시하지 않음 | 폐기된 공개 카드 흐름 |
| 청중 화면 승인 | 이 화면 연결 | 실제 대상 확인 동작 |
| 신뢰 가능한 최신 상태 | 고객에게 표시하지 않음 | 내부 snapshot 용어 |
| 청RE중 화면 보호됨 | 발표 화면 연결을 확인해 주세요. | 오탈자와 과도한 안전 보장 제거 |
| 코칭 지표 | 발표 도움말 | 기본 패널 이름 |
| 코칭 표시 음소거 | 도움말 잠시 숨기기 | 시각적 표시와 음소거 구분 |
| 큐 횟수 | 안내 횟수 | 내부 이벤트명 제거 |
| 발화 집계 | 말하기 기록 | 사용자 언어 |
| 발화 요약 | 말하기 통계 | 생성 요약이 아닌 수치 집계라면 이렇게 표시 |
| 마지막 현재 속도 | 마지막으로 측정한 말하기 속도 | 시간 기준 명확화 |
| 마지막 직전 속도 | 직전 구간의 말하기 속도 | 비교 대상 명확화 |
| 최종 발화 수 | 기본 결과에서 제외 | STT FINAL 이벤트 수는 발화 품질 점수가 아님 |
| 질의응답 세션 열기 | 질문 답변 시작 | 내부 세션 생성 대신 사용자 행동 |
| 질문에 답변하기 | 답변 제안 받기 | AI 기능임을 명시 |
| 참고 문서 {ordinal}번째 조각 | 문서명 + 확인된 페이지/절, 없으면 문서명 | chunkOrdinal을 페이지로 바꾸면 안 됨 |
| 일시적 보류 | 답변을 만들지 못했습니다. 다시 시도해 주세요. | 장애와 자료 부족 분리 |
| 발표 리포트 | 발표 결과 | 내비게이션/제목 통일 |
| 발표 흐름과 파생 집계 | 발표 시간과 질문 기록을 확인하세요. | 무엇을 얻는지 명시 |

소스 표기에는 실제 존재하는 메타데이터만 사용한다. 파일명·페이지 정보가 없는 데이터에
그럴듯한 제목이나 페이지 번호를 만들어 붙이지 않는다. 추가가 필요하면 private DTO에
선택적 `documentTitle`, `pageNumber`, `sectionTitle`을 넣고 기존 ID/ordinal은 그대로 보존한다.

### 3.3 문장 규칙

- 제목은 명사 또는 짧은 행동, 버튼은 실제 동작: `자료 추가`, `발표 시작`, `다시 연결`.
- 안내는 `-세요`, 상태는 `-하고 있습니다`/`-했습니다`, 오류는 원인과 다음 행동을 함께 쓴다.
- 버튼과 진행 문구를 구분한다. `분석 중` 버튼에 또 누를 수 있는 것처럼 보이는 효과를 주지 않는다.
- `승인됨`은 승인 주체와 대상을 설명할 수 있을 때만 쓴다.
- `안전`, `정확`, `저장되지 않음`, `항상` 같은 보장은 기술·운영 사실과 일치해야 한다.
- `로그인 정보는 브라우저에 저장되지 않습니다`는 제거한다. 세션 쿠키가 있고 브라우저의
  비밀번호 저장 기능도 있으므로 현재 문구는 범위가 불명확하다. 검증된 보안 설명은 별도 안내에 둔다.
- 단위는 `분 30초`, `분당 단어 수`처럼 읽을 수 있게 표시한다. 한국어 측정 단위와
  토큰/단어 집계 정의를 확인하기 전에는 WPM을 다른 의미의 지표로 재명명하지 않는다.
- 띄어쓰기: 발표 자료, 참고 자료, 발표 화면, 전체 화면, 발표 시간, 말하기 속도.
- 한국어 조사와 복수형은 변수 뒤에 기계적으로 붙이지 않는다. `{count}개`, `{ordinal}번 슬라이드`.
- KO/EN은 키와 치환 변수 집합을 일치시킨다. 오류 코드·enum·사용자 원문은 번역하지 않는다.
- 고객 문자열 검사는 문구 자체를 고정하는 테스트가 아니라, 번역 키/변수/enum 매핑의
  완전성 검사와 실제 화면 검토로 한다.

## 4. 정보 구조와 화면별 경험

### 4.1 내비게이션과 경로

```text
Impromptu
  내 발표
    발표 만들기
    발표 자료와 참고 자료
    발표자 화면
    질의응답
    발표 결과
  계정 메뉴
    언어
    로그아웃

발표 화면: 위 메뉴의 목적지가 아니라 "발표 화면 열기"로 여는 별도 출력
팀원 질문: 초대받은 발표의 질문 입력만 제공하는 제한된 화면
```

권고 신규 private 경로: `/presentations`, `/presentations/new`,
`/presentations/:presentationSessionId`, `/presentations/:presentationSessionId/present`.
기존 `/reports/:presentationSessionId`는 유지하고 `질의응답 / 발표 결과` 탭을 제공한다.
현재 `/`와 `/session`은 인증 후 내 발표 또는 현재 발표로 연결하는 호환 진입점으로 둔다.
`/live-publication`은 안내 후 발표 준비로 돌아가게 하고 private/public API의 410은 유지한다.
고객 주소를 한 번에 모두 변경하는 작업은 하지 않는다.

새 목록은 실제 private 저장소 조회가 필요하다. localStorage에 결과 목록을 모아
영속 기능처럼 보이게 하지 않는다. 기존 발표 세션을 일단 목록 단위로 쓰고,
새로운 조직/프로젝트/폴더/복수 버전 도메인은 이 변경에 추가하지 않는다.

목록 항목: 발표 식별자, 소유자 기준 접근 제어, 제목, 생성/최근 변경 시각, 자료 준비 상태,
보고서 유무. 제목 기본값은 업로드 파일명이고 수정할 수 있다. 상태는 기존 서버 상태에서
계산한다. 클라이언트의 `presentationStarted`만 DB에 복사하지 않는다.
신규 조회/이름 수정 API는 private 역할에 추가하고 다른 계정의 제목 존재 여부도 노출하지 않는다.
삭제·보관·공유 링크 공개 기능은 별도 설계 없이 덧붙이지 않는다.

### 4.2 로그인과 가입

제목 `Impromptu에 로그인`, 설명 `발표 자료를 준비하고, 발표와 질문에 필요한 정보를 확인하세요.`,
필드 `아이디 / 비밀번호`, 버튼 `로그인`, 보조 링크 `계정 만들기`.
기존 username 규칙을 숨기거나 이메일처럼 꾸미지 않는다.
로그인 실패는 계정 존재 여부를 구별하지 않는 기존 문구 수준을 유지한다.

`팀 메모가 청중에게 절대 보이지 않는다`는 전역 안내를 첫 화면에 두지 않는다.
발표 화면 연결 시 `발표 화면에는 슬라이드만 표시됩니다. 화면 공유 시 이 창이 아닌
발표 화면을 선택하세요.`라고 구체적으로 안내한다.
화면 복제·실수로 private 창 공유하는 상황까지 시스템이 막아 준다고 표현하지 않는다.

### 4.3 내 발표

- 첫 진입: `첫 발표를 준비해 보세요.` / `발표 만들기`.
- 목록: 제목, 최근 수정 시각, 자료 준비 상태, `이어서 준비` 또는 `발표 결과 보기`.
- 불러오기 실패: 빈 목록처럼 보이지 않게 `발표 목록을 불러오지 못했습니다.`와 재시도.
- 계정 변경: 이전 계정의 목록·미리보기·답변·보고서 상태를 즉시 비운다.
- 새로고침/새 기기: 서버에서 복원하며, 진행 중 발표를 자동 재생하거나 마이크를 켜지 않는다.

### 4.4 자료 준비

첫 행동은 `발표 자료 올리기`. 지원 형식 `.pptx, .pdf`와 실제 서버 파일 크기 한도를 표시한다.
참고 자료는 선택 사항임을 표시한다. 최초부터 연결, 디버그, 보고서, 승인 패널을 한꺼번에 펼치지 않는다.

진행 상태는 실제 작업 단계만 표시한다.
`파일 업로드 중 -> 슬라이드 준비 중 -> 관련 자료 분석 중`.
측정할 수 없는 퍼센트·남은 시간을 꾸며 내지 않는다.

슬라이드 준비와 AI 준비 상태를 분리한다.
슬라이드가 준비되면 AI 분석이 실패해도 일반 발표를 할 수 있다.
반대로 업로드가 끝났다는 이유만으로 `AI 답변 준비 완료`라고 하지 않는다.
암호화 문서, 미지원 파일, 용량 초과, 텍스트 없음, OCR 불가, 일부 슬라이드 실패에
각각 재업로드/텍스트 포함 PDF/참고 문서 추가/일반 발표 계속 동작을 제공한다.

자료 교체 시 기존 display binding, 진행 슬라이드, 추천 결과의 세션/deck identity를 확인한다.
짧은 새 자료에서 이전 slide index를 재사용하지 않는다. 이전 자료에 대한 답변을 새 자료의 답변처럼
남겨 두지 않는다. 입력/권한/네트워크 실패를 `자료 없음`으로 바꾸지 않는다.

### 4.5 발표자 화면과 공개 출력

준비 화면의 주 행동은 `발표 화면 열기`, 연결 뒤에는 `발표 시작`.
발표 중 중심은 현재 슬라이드, 이전/다음, 시간, 연결 상태다.
관련 자료·발표 도움말은 보조 영역으로 두고 업로드 설정은 접는다.
오류 복구와 마이크 중지는 접힌 설정 안에 숨기지 않는다.

공개 화면은 고객 내비게이션·계정·모델 상태·질문·원문 문서·답변·진단 정보를 표시하지 않는다.
미연결 직접 진입: `발표 화면을 연결해 주세요.`와 발표자 화면에서 여는 방법을 안내한다.
현재처럼 콘솔이라는 개념 하나를 던지고 끝내지 않는다.
연결 대기/만료/연결 끊김은 관객에게 필요한 짧은 상태만 보이고, 상세 원인은 발표자에게 보낸다.
렌더 검증 실패는 준비 완료로 표시하지 않는다.

### 4.6 AI 도움말

관련 자료 카드에는 제목, 필요한 짧은 내용, 원문/슬라이드 위치를 보여 준다.
출처 종류, 답변 검증, 재사용 권리는 별개 속성이다.
`업로드한 자료`라는 이유로 초록색 `정확함` 배지를 붙이지 않는다.

질문에 대한 상태는 최소한 다음처럼 나눈다.

| 상태 | 표시와 행동 |
| --- | --- |
| 준비 중 | `자료를 확인하고 있습니다.`; 일반 발표는 허용 |
| 답변 생성 중 | `질문과 관련된 내용을 찾고 있습니다.`; 중복 제출 방지 |
| 답변 있음 | `답변 제안` + 출처; 발표자에게만 표시 |
| 자료 부족 | `올린 자료에서 이 질문에 답할 내용을 찾지 못했습니다.`; 자료 추가/질문 수정 |
| 일시 장애 | `지금은 답변을 만들 수 없습니다.`; 동일 질문 재시도 |
| 서비스 미설정 | `이 환경에서는 AI 답변을 사용할 수 없습니다.`; 입력을 무한 대기시키지 않음 |

현재 설정된 DeepSeek/Space Bunny 정책은 그대로 둔다. 고객 화면에서 제공자 내부 오류와
모델 ID를 펼치지 않되, 운영 진단에는 원인·요청 ID를 유지한다.
`HTTP 200 + abstention`을 답변 성공으로 세지 않는다.
사용자에게 출처 없이 신뢰도 점수나 정답 보증을 추가하지 않는다.

### 4.7 마이크와 발표 도움말

`마이크 사용`과 `발표 도움말 표시`를 구분한다. 후자는 시각 표시를 숨기는 동작이지
녹음 중지의 대체 동작이 아니다. 마이크 사용 중 표시와 중지 버튼은 항상 보인다.
권한 거부 후 자료·슬라이드·직접 질문 입력은 계속 사용할 수 있다.
원격 모델 전송 여부와 저장기간은 실제 배포 설정으로 검증한 문장만 사용한다.
말하기 속도를 측정하지 못한 경우 0으로 보이지 않게 `측정하지 않음`으로 표시한다.

### 4.8 발표 종료, 질의응답, 결과

현재 백엔드는 종료 후 보고서와 Q&A를 제공하므로, 첫 변경에서는 새 서버 생명주기를 만들지 않는다.
종료 화면에 `질의응답 / 발표 결과` 탭을 두고 기본 진입은 `질의응답`으로 한다.
기존 보고서 URL을 직접 방문하면 결과 탭을 선택할 수 있다.
`질의응답 시작`은 기존 open API의 명시적 동작을 호출한다.
Q&A 제출은 발표자가 최종 질문을 확인한 뒤에만 이뤄진다.

슬라이드 발표 종료와 Q&A 완료가 사용자에게 다르게 보이더라도 새 enum을 무조건 만들지 않는다.
현재 reportVersion 1/2와 Q&A 저장 계약을 유지한다.
Q&A 성공 후 결과 탭을 갱신해 이번 질문이 기록되는 것을 보장한다.
보고서 PENDING은 유한한 기다림/재시도/재진입 경로를 제공하고 영원한 로딩으로 두지 않는다.

결과의 첫 정보: 총 발표 시간, 슬라이드별 시간, 기록된 질문/답변, 실제 측정된 말하기 지표.
STT FINAL 개수, 내부 해시, 기술 집계는 고객 기본 결과에서 제외한다.
관련 자료 목록을 `사용한 자료`라고 부르지 않는다. 실제 사용 행위가 기록되지 않기 때문이다.
자료가 없을 때, 질문이 없을 때, 마이크를 켜지 않았을 때를 각각 구분한다.
리로드 후 원래 슬라이드명 복원이 안 되면 순서 정보를 명시하고 가짜 제목을 만들지 않는다.

### 4.9 팀원

이미 승인된 범위는 `질문 전달`이다. 팀원은 별도 로그인과 철회 가능한 세션별 권한을 사용한다.
UI는 `질문 보내기`, `전달됨`, `발표자가 확인하기 전`을 구분한다.
발표자가 확인한 질문만 기존 Q&A 요청으로 제출한다.
팀원에게 발표 제어·보고서·발표자 마이크·RAG 전체·계정 설정을 주지 않는다.
아직 구현되지 않았다면 로그인 설명에 팀 메모를 판매 기능처럼 약속하지 않는다.
음성 인식이 어려운 상황에서 팀원이 질문을 직접 입력하는 기존 사용 목적을 유지한다.

## 5. 문구와 데이터 계약의 분리

1. 1차 변경은 렌더링과 번역 메시지에 한정한다.
2. `preparedEvidence.label === "준비된 근거"` 같은 저장/전송 계약은 유지한다.
3. 화면 제목은 `presentationReportText`의 번역 문자열을 사용한다.
4. 기존 v1/v2 보고서와 현재 dirty test fixture를 새 문구로 전역 치환하지 않는다.
5. 기존 의미를 바꾸는 경우 출처·권리·검증 필드를 먼저 구분한다. enum을 자연어와 혼합하지 않는다.
6. 장래 언어 의존 DTO를 제거하려면 별도의 버전 호환 설계가 필요하다. 이번 카피 작업의 필수
   의존성으로 만들지 않는다.
7. 새 메타데이터는 실제 소비 기능에 필요한 만큼만 private DTO에 추가한다.
8. 폐기 카탈로그 키는 호출부와 현재 테스트를 확인한 후 정리한다. 미사용 번역을 실제 화면 버그로
   보고하거나, 고객이 쓴 `근거`라는 단어를 자동 수정하지 않는다.

문구 인벤토리는 실행 시 `.omo/evidence/product-experience/copy-inventory.md`에 작성한다.
각 행은 `파일/키 | 호출 화면 | 현재 문구 | 새 문구 | 의미 분류 | wire 값 여부 |
KO/EN 변수 | 검증 화면 | 처리 상태`를 가진다.
Console/Stage 카탈로그 전체, 하드코딩 JSX, aria/title/alt, 토스트, 서버 오류 매핑,
manifest/tab title, 개인정보 안내, 고객 문서를 포함한다. 테스트 데이터와 내부 문서는 별도 분류한다.

## 6. 단계와 의존성

| 단계 | 작업 | 종료 조건 |
| --- | --- | --- |
| A 기준 확정 | 24-26 | 기존 변경 보호, 용어와 화면 상태 계약 완료 |
| B 즉시 체감 정리 | 27-30 | 로그인·내비게이션·준비·문구 정리, 기존 보고서 유지 |
| C 실제 동선 완성 | 31-36 | 화면 연결·발표·Q&A·팀원·결과 흐름 연결 |
| D 재방문과 운영 | 37-39 | 내 발표 복원, 접근성, 배포 설정 일치 |
| E 통합 인수 | 40-41, F1-F7 | 테스트·실제 브라우저·문서가 같은 제품을 설명 |

이는 순서이지 일부만 끝내고 전체 완료라고 선언하는 축소 범위가 아니다.
기존 수정 파일이 많으므로 구현 승인 후에는 소유권이 겹치는 파일을 직렬로 다룬다.
계약/서버 변경 후 소비 UI를 구현한다. 독립 작업은 mass-ulw 단계별 DAG로 병렬 실행하되,
하나의 전체 작업 그래프에 모든 단계를 미리 묶지 않는다.

## Todos

아래 모두 **미실행**이다. 증거 루트는 실행 때 만드는
`.omo/evidence/product-experience/`이며 `task-24/`부터 `task-41/` 아래 명령 로그, 화면, 네트워크 기록,
정리 기록을 둔다. 로그에는 쿠키·비밀번호·초대 토큰·사용자 문서 원문을 저장하지 않는다.
커밋 예시는 구현 뒤 커밋 권한을 받았을 때만 사용한다. 이 계획 작성은 커밋 권한이 아니다.

- [ ] 24. 현재 변경과 제품 동작 기준선 확보
  - Recommended task executor category: `deep-low`
  - Depends on: 1-5 (기존 기준선); 해당 작업들의 결과만 읽고 사전 변경을 덮어쓰지 않는다.
  - Files: 현재 `git status --short`, `apps/console/src`, `apps/stage/src`, 기존 ideal-experience 계획.
  - Work: dirty/untracked 파일 소유권·diff 해시 기록. 기존 계획의 구현 여부를 증거로 구분.
  - Acceptance: 기존 작업 손실 0; source/deployed/future 각각 분리된 기준선.
  - QA: `git status --short`; 관련 기존 테스트를 먼저 읽고 `bun run test:browser` 1회. 로그인·Stage 직접 진입 캡처. 실패는 그대로 기록.
  - Evidence/commit: `task-24/baseline.md`, `task-24/checks.log`; 기준선만으로 제품 수정 커밋 없음.

- [ ] 25. 제품 용어와 전체 문구 인벤토리 확정
  - Recommended task executor category: `writing`
  - Depends on: 24.
  - Files: Console/Stage `src/locales`, `auth-pages.tsx`, `private-shell.tsx`, `docs`, app metadata/manifests.
  - Work: 5절 행 형식으로 모든 고객 문자열 분류; wire enum, 사용자 원문, 미사용 키 분리.
  - Acceptance: 사용 중 키가 화면·의미·교체 문구에 모두 매핑; 3.2표의 중의성 해소.
  - QA: 실제 카탈로그 전체와 인벤토리 키 집합 대조. 사용자 질문 속 `근거` 및 DTO 고정값을 수정 대상으로 잡지 않았는지 수동 검토.
  - Evidence/commit: `copy-inventory.md`, `task-25/coverage.json`; `docs(product): define customer terminology`.

- [ ] 26. 화면 상태와 디자인 기준 정리
  - Recommended task executor category: `visual-engineering`
  - Depends on: 25.
  - Files: `apps/console/DESIGN.md`, `packages/ui`, Console/Stage 화면 설계.
  - Work: 4절 구조·주 행동·오류·모바일·초점 이동 반영. 기존 중립색/조용한 화면 유지.
  - Acceptance: 준비/발표/Q&A/결과가 다른 주 행동을 가지며 내부 ID가 주 콘텐츠가 되지 않음.
  - QA: 코드 없는 화면 명세를 1440x900, 1024x768, 390x844, 320px 및 200% 확대 기준으로 검토. 오류와 긴 영어 문구도 포함.
  - Evidence/commit: `task-26/screen-state-spec.md`; `docs(ui): specify presentation experience states`.

- [ ] 27. 인증 화면과 제품 메타데이터 수정
  - Recommended task executor category: `visual-engineering`
  - Depends on: 16, 26.
  - Files: `auth-pages.tsx`, `auth-session.tsx`, Console locales, `src/app/(console)/layout.tsx`, public manifest.
  - Work: 로그인/가입/로그아웃 이름과 정확한 안내, title/description/aria 반영; username 계약 유지.
  - Acceptance: `비공개 발표 제어`가 고객 진입 설명에서 사라지고 로그아웃 동작이 이름과 일치.
  - QA: `bun test apps/console/src/App.test.tsx`; 실제 가입·로그인 실패·로그아웃, KO/EN 데스크톱/모바일. 인증/CSRF 동작 불변.
  - Evidence/commit: `task-27/auth-{ko,en}-{desktop,mobile}.png`, `task-27/checks.log`; `fix(console): clarify authentication copy`.

- [ ] 28. 비활성 공개 승인 동선 제거
  - Recommended task executor category: `visual-engineering`
  - Depends on: 27.
  - Files: `private-shell.tsx`, `console-routes.tsx`, `live-publication-page.tsx`, locales.
  - Work: 메뉴 제거, `/live-publication` 호환 안내, 현재 발표 복귀. 서버 410과 private 추천은 유지.
  - Acceptance: 막힌 공개 카드 기능을 고객이 수행 가능한 기능으로 발견하지 않음.
  - QA: `bun test apps/console/src/App.test.tsx`; 옛 URL 직접 진입/뒤로가기/키보드. 인증된 공개 카드 API 410, Stage 카드 0 유지.
  - Evidence/commit: `task-28/route-compatibility.json`, 화면; `fix(console): retire unavailable publication navigation`.

- [ ] 29. 문맥별 문구와 출처 표시 수정
  - Recommended task executor category: `visual-engineering`
  - Depends on: 17, 28.
  - Files: locales, `evidence-card.tsx`, `reference-documents-panel.tsx`, `qa-answer-cards.tsx`, `report-qa-defense.tsx`, `presentation-report-text.ts`.
  - Work: 용어표 적용; 권리/출처/검증 구분; 실제 정보가 없는 문서 페이지를 만들지 않음.
  - Acceptance: INTERNAL이 `정확함`으로 읽히지 않음; `청RE중`/raw reason/enum/chunk 기본 노출 제거.
  - QA: `bun test apps/console/src/evidence-card.test.tsx apps/console/src/locale-parity.test.ts apps/console/src/session-report-view.test.ts`; v1/v2 고정 label 파싱 유지, 실제 카드와 없는 날짜/출처 표시 확인.
  - Evidence/commit: `task-29/copy-coverage.json`, 카드/보고서 캡처; `fix(console): separate customer copy from evidence contracts`.

- [ ] 30. 자료와 AI 준비 상태 분리
  - Recommended task executor category: `deep-low`
  - Depends on: 29.
  - Files: `deck-upload-panel.tsx`, `reference-documents-panel.tsx`, `evidence-preparation-panel.tsx`, 대응 backend/ingestion 오류 매핑.
  - Work: 슬라이드 사용 가능/검색 준비/AI 사용 가능을 별도 상태로 표시; 원인별 복구 연결.
  - Acceptance: AI 불가 상태에서도 준비된 슬라이드 발표 가능; 업로드 완료를 AI 준비로 오인하지 않음.
  - QA: `bun test apps/console/src/deck-upload.test.tsx`; 정상 PDF/PPTX, 암호화/용량초과/텍스트없음/분석실패, 실제 서비스 미설정 분기. ingestion 변경 시 해당 pytest.
  - Evidence/commit: `task-30/readiness-matrix.json`, 화면; `fix(console): distinguish slide and assistance readiness`.

- [ ] 31. 초대와 화면 연결 권한 경로 구현
  - Recommended task executor category: `deep-high`
  - Depends on: 6, 7, 24, 26. 기존 6/7의 계약·마이그레이션은 재구현하지 않는다.
  - Files: 기존 ideal-experience 작업 6/7의 contracts, private authority, projection gateway, 테스트.
  - Work: 승인된 최대 90초 일회용 비권한성 초대, 대상 식별, 최신 CAS 검증, 철회 구현/기존 구현 확인.
  - Acceptance: 초대만으로 snapshot 권한 없음; 다른 소유자/만료/재사용/동시 승인 거절.
  - QA: `bun run test:security`, `bun run check:boundaries`; 두 독립 브라우저 컨텍스트로 초대 교환부터 host 쿠키 claim까지 검증. 시간은 주입 clock.
  - Evidence/commit: `task-31/invitation-contract.json`, `task-31/checks.log`; `feat(display): support presenter-issued pairing invitations`.

- [ ] 32. 한 제품 안의 발표 화면 연결 완성
  - Recommended task executor category: `visual-engineering`
  - Depends on: 12, 13, 30, 31.
  - Files: `audience-panel.tsx`, `audience-screen.ts`, `stage-origin.ts`, Stage `landing-page.tsx`, locales.
  - Work: 같은 기기/다른 기기 연결, 대상 확인, 승인, 링크/만료/팝업 복구를 2.4절 흐름으로 통합.
  - Acceptance: 사용자가 Stage 주소를 직접 관리하지 않음; opener 없이 정상 초대로 연결됨.
  - QA: `bun test apps/console/src/audience-screen.test.tsx apps/stage/src/App.test.tsx`; opener 없음·만료·재연결·자료 교체, 실제 두 프로필의 일치한 식별정보 확인.
  - Evidence/commit: `task-32/pairing-trace.json`, 양쪽 화면; `feat(console): unify presentation display connection`.

- [ ] 33. 발표 중 출력과 연결 복구 정리
  - Recommended task executor category: `deep-low`
  - Depends on: 15, 16, 32.
  - Files: `playback-panel.tsx`, `workspace-page.tsx`, Stage `display-page.tsx`, `slide-view.tsx`, subscription/topology modules.
  - Work: 실제 렌더 기준 READY, deck 교체 시 identity/index 초기화, 연결 끊김/전체화면 종료 복구.
  - Acceptance: 201/202만으로 송출 성공을 표시하지 않음; private 상태가 공개 DOM·network·cache에 없음.
  - QA: `bun run test:topology`, `bun test apps/stage/src`; asset 실패·연속 슬라이드·disconnect/reconcile·짧은 새 deck. 실제 슬라이드와 발표자 표시 비교.
  - Evidence/commit: `task-33/render-recovery.json`, 화면; `fix(playback): align display readiness with rendered slides`.

- [ ] 34. 답변과 마이크 상태를 정직하게 표시
  - Recommended task executor category: `deep-low`
  - Depends on: 9, 10, 19, 30.
  - Files: `qa-defense-panel.tsx`, `qa-answer-cards.tsx`, `cockpit-audio-capture.tsx`, `coaching-display.tsx`, typed backend outcome 매핑.
  - Work: 답변/자료부족/일시장애/미설정 분리, 시각 도움말과 마이크 수명 구분, source 메타데이터 필요한 만큼 추가.
  - Acceptance: 권한 거부 후 직접 질문 가능; 숨기기와 녹음 중지가 구별됨; 모델 성공률을 과장하지 않음.
  - QA: `bun run test:audio-lifecycle`, `bun test apps/console/src/qa-defense-panel.test.tsx`, `bun run test:retrieval`; 실제 설정된 제공자로 지원/불지원 질문 각 실행, 답변과 abstention 따로 기록.
  - Evidence/commit: `task-34/assistance-outcomes.json`, 마이크/답변 화면; `fix(assistance): expose actionable readiness and answer states`.

- [ ] 35. 팀원 질문 전달 경험 완성
  - Recommended task executor category: `deep-high`
  - Depends on: 8, 14, 34. 기존 8/14의 grant·inbox·migration은 재구현하지 않는다.
  - Files: 기존 ideal-experience 작업 8/14의 grant/inbox/routes/UI; 별도 private ordered migration.
  - Work: 별도 계정의 질문 전용 초대·철회·전달·발표자 검토. 공유 발표자 로그인 사용 금지.
  - Acceptance: B는 허용된 발표에 질문만 전달; C는 읽기/쓰기 불가; B 철회 즉시 차단.
  - QA: `bun run test:security`와 세 계정 실제 브라우저; playback/report/retrieval 직접 호출 거절, 질문 확인 후 명시 제출.
  - Evidence/commit: `task-35/permission-matrix.json`, 질문 전달 화면; `feat(team): add scoped question assistance`.

- [ ] 36. 질의응답과 발표 결과 동선 통합
  - Recommended task executor category: `visual-engineering`
  - Depends on: 11, 18, 22, 33, 34, 35.
  - Files: `playback-panel.tsx`, `report-page.tsx`, `qa-defense-panel.tsx`, `presentation-report.tsx`, report text/view modules.
  - Work: 종료 후 Q&A/결과 탭, PENDING 복구, Q&A 후 결과 갱신, 기본 지표 단순화. v1/v2 호환 유지.
  - Acceptance: 보고서 아래 묻힌 Q&A 해소; 질문 저장과 새로고침 결과 일치; 관련 자료를 사용 실적으로 부르지 않음.
  - QA: `bun test apps/console/src/presentation-report.test.tsx apps/console/src/presentation-report-page.test.tsx apps/console/src/session-report-view.test.ts`; v1/v2, PENDING->FINALIZED, 저장 실패, 마이크 미사용, 질문 없음, 재진입.
  - Evidence/commit: `task-36/end-to-report.json`, 각 탭 캡처; `feat(console): connect post-talk questions and results`.

- [ ] 37. 서버 기반 내 발표와 재진입 제공
  - Recommended task executor category: `deep-high`
  - Depends on: 16, 36.
  - Files: `console-routes.tsx`, `auth-session.tsx`, private session/report repositories/routes, 신규 presentation list UI와 ordered private migration.
  - Work: 4.1절 조회/제목 수정 계약, 업로드 파일명 초기 제목, owner pagination, 기존 세션 backfill 규칙, 새로고침 복원.
  - Acceptance: 두 계정 목록 분리; 다른 기기에서 자기 자료/결과 재진입; 자동 마이크/발표 재시작 없음.
  - QA: private HTTP/DB owner-isolation 테스트와 `bun run test:db`; 두 계정·새 브라우저·서버 재시작·옛 보고서 deep link.
  - Evidence/commit: `task-37/library-recovery.json`, DB/migration 로그; `feat(presentations): restore owned presentations across visits`.

- [ ] 38. 언어 접근성과 반응형 전체 검사
  - Recommended task executor category: `visual-engineering`
  - Depends on: 20, 37.
  - Files: 양 앱 UI/locales, `apps/console/DESIGN.md`, shared UI의 필요한 부분.
  - Work: 모든 화면 KO/EN, 키/placeholder 완전성, aria/초점/상태 낭독, 고대비/축소 모션, 좁은 화면 처리.
  - Acceptance: 주요 버튼 겹침/잘림/도달 불가 0; 오류 후 초점·입력 보존; Stage에 private aria/숨김 DOM 없음.
  - QA: `bun test apps/console/src/locale-parity.test.ts`, `bun run check:browser-runtime`; 1440/1024/390/320px, 200% 확대, 키보드와 스크린리더. 정확한 문장 문자열 고정 테스트 추가 금지.
  - Evidence/commit: `task-38/accessibility.json`, 상태별 화면; `fix(ui): complete localized accessible presentation flows`.

- [ ] 39. 배포 설정과 고객 진입점 일치
  - Recommended task executor category: `deep-low`
  - Depends on: 38.
  - Files: `compose.production.yaml`, `.env.example`, deploy runbook, 양 앱 proxy/config, `stage-origin.ts`.
  - Work: 실제 origin/port/internal API/build args의 일치 검사, runtime과 브라우저 번들의 Stage 대상 검증.
  - Acceptance: 이전 shell env가 .env를 덮어쓴 상태를 탐지; host 쿠키 분리; 한 고객 링크에서 실제 공개 창까지 이동.
  - QA: `docker compose --env-file .env -f compose.production.yaml config`는 비밀값을 제외해 검사; 빌드 이미지 digest/컨테이너 digest 대조, readyz와 인증 API, 브라우저 열기. `.env`가 없으면 `.env.example`을 복사해 로컬 전용으로 만들고 부재를 그대로 기록한다 (비밀값 커밋 금지).
  - Evidence/commit: `task-39/config-redacted.json`, `task-39/image-digests.json`; `fix(deploy): verify public and internal origin consistency`.

- [ ] 40. 통합 회귀와 실제 발표 흐름 검증
  - Recommended task executor category: `deep-low`
  - Depends on: 21, 22, 23, 39 (and, transitively through 39, all of 24-38).
  - Files: 기존 tests/security, tests/e2e, tests/contract, 양 앱 테스트와 실제 서비스.
  - Work: 7절 시나리오를 최종 트리에서 실행. 구조 변경은 실패하는 회귀부터 시작.
  - Acceptance: 단위 테스트, 보안/DB, 빌드, 실제 브라우저가 같은 결과; 전역 통과를 일부 테스트로 대체하지 않음.
  - QA: 7.1 명령 전체와 7.2 매트릭스. 환경 장애는 정확한 실패/미실행으로 남기고 완료로 둔갑시키지 않음.
  - Evidence/commit: `task-40/acceptance.json`, 종료코드와 redacted traces; `test(product): verify complete presentation journeys`.

- [ ] 41. 고객 안내와 운영 문서 정합성 마무리
  - Recommended task executor category: `writing`
  - Depends on: 40.
  - Files: README, `docs/DEMO-SCOPE.md`, `docs/final-manual-qa.md`, deploy runbook, 사용자 도움말.
  - Work: 구현된 기능만 소개; 공개 카드/데모/실험 문구와 실제 동작 구분; 내부 운영 문서는 내부 용어 허용.
  - Acceptance: 안내한 버튼/순서/권한이 현재 배포와 일치; 무료 임시 터널을 영구 운영으로 부르지 않음.
  - QA: 새 사용자 시나리오를 문서 순서대로 직접 실행, 깨진 링크/없는 버튼/비활성 기능 약속 확인. 문장 고정 테스트 없음.
  - Evidence/commit: `task-41/documentation-walkthrough.md`; `docs(product): align guidance with shipped experience`.

## 7. 검증과 완료 판정

### 7.1 자동 검사

구현 중 수정 파일의 LSP diagnostics를 빌드 전에 확인한다.
문서만 바꾼 이번 계획 세션에서 제품 테스트·빌드를 새로 실행한 것처럼 보고하지 않는다.
구현이 시작되면 아래는 최종 통합 트리에서 수행한다.

```bash
bun run lint
bun run typecheck
bun run test
bun run build
bun run check:boundaries
bun run check:browser
bun run check:browser-boundary
bun run check:browser-runtime
bun run test:security
bun run test:db
bun run test:e2e
```

Python 변경 시 `services/ingestion/AGENTS.md`의 pytest 명령을 추가한다.
신규 회귀는 저장소의 해당 테스트 옆에 두며 기존 실패를 문구 변경에 맞춰 숨기지 않는다.
순수 문구 변경은 새 prose assertion을 추가하지 않는다. locale 키·placeholder·wire sentinel·
unknown enum 처리처럼 기계가 소비하는 계약만 자동 검사한다.
기존 UI 테스트의 접근성 이름 조회는 실제 카탈로그 값으로 갱신하되 동작 assertion은 유지한다.
비동기 검사는 트리거 전에 이벤트를 구독하고 bounded timeout으로 끝낸다.
고정 sleep이나 타이밍 운에 기대어 통과시키지 않는다.

### 7.2 실제 화면 인수 매트릭스

| ID | 정상 시나리오 | 실패/경계 시나리오 | 통과 관찰 |
| --- | --- | --- | --- |
| Q01 | 가입/로그인/로그아웃 | 틀린 비밀번호, 다른 계정 전환 | 쉬운 문구, 기존 계정 private 상태 잔류 0 |
| Q02 | PDF/PPTX 업로드 | 용량/암호화/OCR/텍스트 없음 | 실제 상태와 복구 행동 일치 |
| Q03 | 참고 자료 추가 | 일부 파일 실패, 검색 장애 | 파일 수와 사용 가능 상태 정확 |
| Q04 | 같은 기기 발표 화면 연결 | 팝업 차단, 만료, 잘못된 대상 | 대상 확인 후 실제 슬라이드 표시 |
| Q05 | 별도 기기 초대 연결 | opener 없음, 재사용, 제3자 | 초대만으로 권한 없음, 정상 경로는 연결 성공 |
| Q06 | 이전/다음/자료 교체 | 오래된 deck/CAS, 네트워크 단절 | 렌더와 제어 표시 일치, stale command 없음 |
| Q07 | 자료 기반 답변 제안 | 자료부족/공급자 장애/미설정 | 답변·abstention·오류를 구별 |
| Q08 | 마이크 사용/중지 | 권한 거부/장치 제거/탭 종료 | 실제 track/서버 stream 종료, 직접 입력 유지 |
| Q09 | 팀원 질문 전달 | 권한 철회/다른 계정/보고서 읽기 | 허용된 질문 전달만 성공 |
| Q10 | 발표 종료/Q&A/결과 | PENDING/실패/새로고침/v1 | 질문 기록과 보고서 복원, 내용 손실 없음 |
| Q11 | 내 발표 재진입 | 서버 재시작/새 기기/다른 owner | 저장된 자기 자료만 복원 |
| Q12 | KO/EN·키보드·좁은 화면 | 긴 문구/200% 확대/고대비 | 동작 버튼 접근 가능, 한 화면 한 주 행동 |
| Q13 | Stage 네트워크/DOM/storage 검사 | console API/cookie/private import 시도 | public 계약만 존재, 노트/질문/토큰 0 |
| Q14 | 배포 Console의 버튼으로 Stage 열기 | 빌드에 이전 origin 내장 | 실제 최종 origin·asset·쿠키 경로 일치 |
| Q15 | 실제 Windows 11 Chrome/Edge 확장/복제 | 프로젝터 분리/복귀/전체화면 해제 | 공개 출력만 보임, private 기기 분리 안내 정확 |

각 행의 증거는 `task-40/Qxx-{happy,failure}.json`과 필요한 화면 이미지/네트워크 trace다.
(증거 루트 `.omo/evidence/product-experience/`; 작업 증거 디렉터리는 task-24..task-41)
Q15는 실제 장비가 있어야 한다. macOS WebView, HTTP 200, 자동 스크린샷만으로
Windows 현장 인수를 통과했다고 쓰지 않는다. 장비가 없으면 코드 준비와 현장 인수를 분리한다.

### 7.3 제품 품질 기준

- 처음 보는 사람이 Stage/Console/evidence/binding을 배우지 않고 정상 흐름을 수행한다.
- 자료 부족·기능 미설정·서버 장애가 서로 다른 상태로 설명된다.
- 발표 화면에 보일 대상이 언제나 분명하다. private 도움말을 공개한다고 암시하지 않는다.
- `발표 준비 완료`는 무엇이 준비됐는지 명확하고, AI 미준비를 감추지 않는다.
- 고객이 행동을 완료하면 눈에 보이는 결과가 바뀐다. dead-end CTA가 없다.
- 재접속해 자기 자료와 결과를 찾을 수 있다.
- 실제 사용자 평가를 하면 작업 완료율, 도움 요청 지점, 연결 실수, 용어 오해를 기록한다.
  에이전트가 시나리오를 통과한 것만으로 고객이 이해한다고 단정하지 않는다.
- 숫자 성능/SLA 약속은 측정 이후에만 추가한다. 기존 5초 AI bound의 성공/abstention을 분리한다.

## 8. 배포·호환·롤백

1. 기존 dirty 작업은 건드리지 않고 소유자와 겹치는 구현 경로를 조정한다.
2. 문구 변경과 UX 변경을 원자 단위로 적용한다. 새로운 화면 이름 때문에 모든 타입명을 바꾸지 않는다.
3. 초대/목록/권한처럼 신규 서버 계약은 producer가 먼저 배포되고 소비 UI가 뒤따른다.
4. applied migration은 수정하지 않는다. 신규 목록 메타데이터는 기존 row를 보존하는 추가 migration.
5. 보고서 고정 label과 v1/v2는 유지한다. 기존 클라이언트가 읽지 못하는 DTO 변경은 하지 않는다.
6. origin은 실제 host 값으로 확인하고 빌드 시 공개 값과 런타임 내부 값을 분리한다.
   shell 환경변수가 .env보다 우선할 수 있으므로 렌더된 compose와 배포 이미지에서 검증한다.
7. 공개 origin이 바뀌면 기존 display 쿠키/초대가 그대로 이어진다고 가정하지 않는다.
   만료/재연결을 안내하고 오래된 링크에서 private 정보를 표시하지 않는다.
8. 롤백은 호환 가능한 이전 이미지로 한다. 무조건 DB down migration이나 볼륨 삭제를 하지 않는다.
9. 연결 장애 시 마지막으로 확인한 공개 정책에 따라 대기/blackout 처리한다.
   private Console로 redirect하거나 인증 정보를 공유해서 살리는 fallback은 금지한다.
10. 임시 Quick Tunnel은 데모 연결이다. 고정 주소, 운영 주체, 백업/복구, 비용 및 실제 사용 가능성을
    확인하기 전에는 지속 운영되는 판매 서비스라고 완료 보고하지 않는다.

## 9. 범위와 승인

이 문서의 권고안은 상세 계획이며 구현 결과가 아니다.
사용자가 바꿀 수 있는 제품 선택은 명시적으로 분리한다.

- 권고 기본안: Stage의 기술적 분리는 유지하고 사용자에게는 `발표 화면`으로 통합.
- 고객 용어: `자료 준비 / 관련 자료 / 답변 제안 / 출처 / 발표 결과`.
- 신규 기능: 내 발표 목록·재진입과 기존 승인 계획에 있는 팀원 질문 전달.
- 유지: private/public 경계, slide-only 공개 출력, 기존 모델 정책, 명시적 연결 확인.
- 제외: 요금제/결제/브랜드 전면 교체/신규 모델/조직 관리자/실시간 공동 편집.

먼저 문구만 고쳐 눈에 띄는 불편을 줄일 수 있지만, 그것을 제품 구조 개선 완료로 보고하지 않는다.
반대로 이 문제를 해결하려고 모든 서비스를 다시 만드는 것도 권하지 않는다.

## Final verification wave

- [ ] F5. 구조와 권한 경계 독립 검토
  - Recommended task executor category: `deep-high`
  - Verify: Q04-Q06/Q09/Q13, 별도 origin/build/SW/cookie, 현재 초대·CAS·owner 계약.
  - Acceptance: 기술 분리를 제거하지 않고 단일 사용자 경험을 만들었음; private 노출 0.
  - Evidence: `<attemptDir>/final/F5-architecture-review.md`; 발견된 재현 결함을 수정한 뒤 해당 검사 재실행.

- [ ] F6. 문구와 화면 경험 독립 검토
  - Recommended task executor category: `visual-engineering`
  - Verify: 인벤토리, 모든 Q01-Q12 화면, KO/EN, source/rights/verification 의미 구분.
  - Acceptance: 내부 용어와 dead-end CTA 없음; wire 고정값은 보존; 사용자 원문 미변경.
  - Evidence: `<attemptDir>/final/F6-product-copy-review.md`, 상태별 화면.

- [ ] F7. 최종 배포와 완료 주장 검증
  - Recommended task executor category: `deep-low`
  - Verify: 명령별 종료코드, 최종 tree/image digest, Q14 실제 브라우저, Q15 장비 증거 또는 미검증 표시.
  - Acceptance: API health를 제품 완성으로 대체하지 않음; 새 사용자 동선·실제 출력·보고서 재진입이 관찰됨.
  - Evidence: `<attemptDir>/final/F7-release-receipt.json`; 미실행/외부 승인 대기는 완료와 분리해서 보고.


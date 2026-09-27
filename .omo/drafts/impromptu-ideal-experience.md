---
slug: impromptu-ideal-experience
status: plan-written-review-unavailable
intent: unclear
review_required: true
plan_path: .omo/plans/impromptu-ideal-experience.md
plan_sha256: 6b3c210d840cd2515607d78faf560e218e1ed93180f0d860042b2fa66d3cffdf
review_round_id: null
review_round_limit: 5
pending-action: request native plan-reviewer in an eligible ulw-plan session; substitute independent audit APPROVED on 2026-09-27 but gated sign-off remains outstanding
review:
  plan_reviewer:
    status: unavailable-plan-gate
    workspace_root: null
    runtime_home: null
    target: .omo/plans/impromptu-ideal-experience.md
    round_id: null
    plan_sha256: 6b3c210d840cd2515607d78faf560e218e1ed93180f0d860042b2fa66d3cffdf
    launch_id: null
    session: null
    result: "Host refused plan-reviewer (twice): plan-gated; no explicit ulw-plan invocation recorded by this session."
  substitute_independent_review:
    status: approved
    agent: "task st_01a0e2ce, deep-low lane (devin/swe-2-max)"
    rounds: 2
    round1: "REVISE — B1 Qxx evidence path (task-17 vs task-40), B2 stale F1/F4 scope (23 tasks/8 IS vs 41/12), B3 playback-panel.test.ts filename; all fixed."
    round2: "APPROVE — nothing blocks dispatch; residual 5 cosmetic items, 4 cleaned (F1 refs 1-41, seven checks, F1-F7 terminals, vestigial sentence)."
    note: "High-accuracy independent audit, not the gated plan-reviewer sign-off."
approach: Map evidence-backed end-to-end user journeys, preserve active work, then plan gap closure and independent verification without weakening public/private boundaries.
---

# Draft: impromptu-ideal-experience

## Affected user and ideal state

### Affected people and their use

| Person | Today, evidenced use | Intended use and why |
| --- | --- | --- |
| Presenter | Signs in, uploads a deck and reference documents, opens an audience window, controls slides and opts into microphone/coaching (`apps/console/src/console-routes.tsx:11-31`, `apps/console/src/workspace-page.tsx:43-65,186-249`). Ending the talk navigates to a report, where the presenter can type or dictate a question and read a cited answer or an honest abstention (`apps/console/src/report-page.tsx:84-103`, `apps/console/src/qa-defense-panel.tsx:20-25,107-153`). | A single legible preparation -> talk -> Q&A -> report flow that never hides essential controls, loses a draft, publishes private information, or pretends an unavailable answer is supported. Interruptions must have an actionable recovery path. |
| Teammate | A prior product decision envisages a teammate entering a noisy/distant audience question (`reference/impromptu-project.md`), but the inspected Q&A form is on the authenticated presenter report and its request describes only `TYPED`/`SPOKEN`, not a teammate channel (`apps/console/src/qa-defense-panel.tsx:27-53`, `apps/console/src/qa-defense.ts:23-28`). A publication teammate grant exists but is unrelated (`services/private-backend/src/http/routes/coordinator-commands.ts:142-154`). | For the recorded direct teammate-input use case, propose a narrow, authorized question-entry channel on a separate device that delivers the exact question privately to the presenter. This is a proposed requirement, not a claim that such a portal exists. |
| Audience member | Sees an opener-created public Stage whose display shows only the current slide, including blackout and reconnection (`apps/stage/src/landing-page.tsx:29-63`, `apps/stage/src/display-page.tsx:80-143`). A directly opened URL on another device is inert (`apps/stage/src/landing-page.tsx:139-145`). | Sees the right slide promptly and only public pixels; a failure gives a clear, non-private state, not an indefinitely blank or stale projection. A projector/second-device setup must match the supported venue modes. |
| Operator / privacy observer | Uses the seven-step physical rehearsal and records projector, network, display-mode, recovery, and privacy results (`docs/final-manual-qa.md:29-76`). | Can distinguish verified automation from a real venue rehearsal, and never signs off a release while physical/private-pixel gates are unobserved. |

### Ideal-state rows (proposed; each reason is part of the acceptance contract)

| Row | Observable property | Reason |
| --- | --- | --- |
| IS-1 | Deck and references produce a readable, indexed preparation state with a clear next step, and invalid/empty input produces one recoverable explanation. | A presenter must know what is ready before stepping on stage; ambiguous readiness disrupts the talk. Current preparation: `apps/console/src/workspace-page.tsx:205-258`; failure gap: `apps/console/src/reference-documents-panel.tsx:23-32`. |
| IS-2 | The presenter pairs the intended public display in every documented supported topology, with explicit authority, fingerprint/deck validation, no accidental neighboring binding, and clear expiry/retry. | A wrong or unpaired projector is both a failed presentation and a privacy boundary breach. Intended modes: `docs/DEMO-SCOPE.md:9-30`; current pairing: `apps/stage/src/landing-page.tsx:29-63,139-145`. |
| IS-3 | At supported desktop and compact widths, slide, transport, prepared evidence, and consent/coaching remain legible and reachable at the phase they matter, including keyboard and Korean/English labels. | A presenter cannot search or scroll for control during a live talk; accessibility and language are part of usability, not decoration. Current phase layout: `apps/console/src/workspace-page.tsx:208-258`; target: `apps/console/DESIGN.md:38-67,111-125`. |
| IS-4 | The audience sees only the current authorized public slide or a clearly bounded public recovery state, with no private data, audience-facing controls, or unapproved cards; reconnect never replays a stale slide command. | This is the current slide-only security contract and preserves audience trust. `apps/stage/src/display-page.tsx:80-143`; `apps/stage/src/use-stage-subscription.ts:88-145`. |
| IS-5 | A presenter or appropriately authorized teammate can capture the exact audience question despite noise, review its transcript/text before submit, then obtain cited support or honest abstention without exposing private sources on Stage. | Noisy-room Q&A is the recorded use case (`reference/impromptu-project.md`); current presenter-only input is `apps/console/src/qa-defense-panel.tsx:27-53,107-153`. A separate teammate channel is a proposed gap closure, not observed functionality. |
| IS-6 | Ending the talk yields a readable, reloadable report with recognizable slide labels, timing and Q&A, without opaque hashes, unexplained internal identifiers, or lost data after navigation. | The output must remain useful when the presenter reviews it later rather than only on the initial redirect. `apps/console/src/report-page.tsx:44-103`; `apps/console/src/presentation-report.tsx:42-199`. |
| IS-7 | Every failure (join expiry, microphone denial, source outage, receipt rejection, reconnect exhaustion) yields a truthful, safe state and a recoverable action when recovery exists; no stale private or public state becomes valid through a fallback. | Silent or misleading failures degrade both speaker confidence and boundary integrity. Current failure paths: `apps/stage/src/landing-page.tsx:100-115`; `apps/stage/src/use-stage-subscription.ts:63-81`; `apps/console/src/audience-panel.tsx:24-32`. |
| IS-8 | Release claims reflect current-tree browser/HTTP behavior, regression/build gates and real venue hardware separately; historical receipts do not stand in for new checks. | An old green file or headless fixture cannot establish that today's demo or physical projector is safe. `docs/final-manual-qa.md:9-19,79-111`; `scripts/verify-browser-runtime.ts:677-721`. |

### Gap rows (observed versus ideal)

| Row | Today versus desired state | Reason and status |
| --- | --- | --- |
| GAP-1 -> IS-1, IS-3, IS-6 | Existing UX Round 2 already touches upload, transport, evidence cards, microphone, Q&A cards, and report; the associated files are dirty and no integrated browser check has been captured in this session. | Verify the current implementation through the real Console and targeted suite before scheduling any fix; do not duplicate C1-C8 or treat a source edit as a pass (`.omo/plans/ux-round2.md:1-23`; `git status --short`). |
| GAP-2 -> IS-2 | Documented separate-controller/typed-code join conflicts with the explicitly inert direct Stage and the still-present Console code field. | The independently opened Stage cannot supply the code the Console asks for; choose an authorized second-device mechanism or explicitly change supported topology (`docs/DEMO-SCOPE.md:11-30,235-239`; `apps/stage/src/landing-page.tsx:139-145`; `apps/stage/src/App.test.tsx:520-557`; `apps/console/src/audience-panel.tsx:108-143`). |
| GAP-3 -> IS-4, IS-8 | Older release/manual QA says publish and retract audience cards, whereas current Stage, gateway and private backend refuse all cards. | The stale release script cannot be used as a completion oracle, and restoring cards would violate the current slide-only product decision (`docs/final-manual-qa.md:55-60`; `apps/stage/src/display-page.tsx:100-143`; `services/projection-gateway/src/http.ts:397-403`; `services/private-backend/src/http/routes/playback-read.ts:11-18`). |
| GAP-4 -> IS-4, IS-7 | Stage join retry silently stops at expiry; a failed reconciliation can remain RECOVERING without terminal explanation, and an HTTP receipt response is emitted as an unparsed browser event. | Audience/operator cannot distinguish a recoverable wait from a failed display; an unchecked receipt breaks the otherwise closed public DTO discipline (`apps/stage/src/landing-page.tsx:100-115`; `apps/stage/src/use-stage-subscription.ts:63-81,124-130`; `apps/stage/src/stage-client.ts:476-490`). |
| GAP-5 -> IS-5 | Separate teammate Q&A entry is not observed in the current Console Q&A or request contract; prior memory describes it as important. | A teammate on another device cannot be assumed to reach a presenter-only report. Scope/authority must be settled before a separate role is planned (`apps/console/src/qa-defense-panel.tsx:27-53`; `apps/console/src/qa-defense.ts:23-28`). |
| GAP-6 -> IS-1, IS-5, IS-7 | Recommendation evidence at earlier and later commits conflicts about 10/10 provider reliability; current-tree end-to-end result has not been measured. | Historical 9/10 and 10/10 are both true of their respective runs, neither proves today's quality or loaded-provider behavior (`.omo/evidence/task-50/final-state.json`, `.omo/evidence/task-53/receipts.json`, `docs/DEMO-SCOPE.md:169-172`). |
| GAP-7 -> IS-2, IS-4, IS-8 | The documented physical rehearsal is not recorded as performed on target hardware; automated ten-run records explicitly are not physical sign-off. | No amount of repository inspection establishes projector/EDID/private-pixel safety (`docs/final-manual-qa.md:9-19,79-111`). |
| GAP-8 -> IS-5 | A spoken-question STT deadline is calculated once when the adapter is created, not when a question is asked. | A question recorded over one minute after backend startup can hit an expired deadline; existing fake-router tests do not validate this (`services/private-backend/src/qa/spoken-question-stt.ts:44-57`). |
| GAP-9 -> IS-3, IS-6 | Production audio reporting stores each FINAL transcript but passes no coaching aggregate, although the report supports one. | A live pace/cue may vanish or read as unavailable in the final report (`services/private-backend/src/bootstrap/audio.ts:47-59`; `services/private-backend/src/report/session-report-finalizer.ts:123-236`). |
| GAP-10 -> IS-3, IS-7 | The active slide index remains a local state value when `activePresentation` changes to a new deck; session sign-out clears only `session`, not presentation/binding state. | A shorter replacement deck may show an invalid preview, and signing into another account in the same tab must not expose the previous account's private UI (`apps/console/src/workspace-page.tsx:40-42,89-103,208-217`; `apps/console/src/auth-session.tsx:71-80,120-133`). |
| GAP-11 -> IS-2, IS-4 | Each display approval submits binding epoch `dbe_0`, despite gateway CAS incrementing after first bind; the Console does not show the pending display fingerprint before explicit approval. | Reopening a closed display is likely to fail after one binding, and a presenter cannot compare the intended display against an adjacent one (`apps/console/src/display-playback.ts:48-68`; `apps/console/src/audience-panel.tsx:104-121`; `services/projection-gateway/src/prepared-evidence.ts:466-483`). Must reproduce before asserting failure. |
| GAP-12 -> IS-1, IS-7 | Failed reference listing becomes an indistinguishable empty list, while upload and evidence errors can display raw backend reason text. OCR absence intentionally degrades scanned-page text to an empty result, unlike older `422 OCR_UNAVAILABLE` prose. | The presenter cannot tell no documents from failed loading or usable images from searchable evidence, and technical/private errors can surface directly (`apps/console/src/reference-documents-panel.tsx:23-32,67-78`; `services/ingestion/src/impromptu_ingestion/adapters/pdf.py:68-87`; `apps/console/DESIGN.md:114-125`). |
| GAP-13 -> IS-4, IS-7 | Stage can report `READY` from a snapshot while verified SVG loading fails and leaves an empty DOM host; Console currently advances its preview after command acceptance, separately from visible asset loading. | An HTTP success or applied command is not proof of a visible audience slide (`apps/stage/src/display-page.tsx:89-122`; `apps/stage/src/slide-view.tsx:44-72`; `apps/console/src/display-playback.ts:79-103`). |
| GAP-14 -> IS-5, IS-6 | The report page reads a `PENDING` report only once and exposes no resubscription or retry action. | A report finalized seconds later can remain indefinitely pending until the presenter reloads (`apps/console/src/report-page.tsx:44-70`). |
| GAP-15 -> IS-5, IS-7 | FINAL audio event forwarding awaits the recommendation for that event, so a slow provider can delay later FINAL events. | Subsequent speech may reach the presenter or report late despite the STT stream itself progressing (`services/private-backend/src/audio-ingest.ts:178-187,463-476`). Verify with a deferred provider and two FINAL events before choosing a concurrency fix. |
| GAP-16 -> IS-3, IS-8 | The checked-in accessibility matrix promises authenticated Console routes, but `accessibilityRoutes` currently lists Stage only. The browser-runtime verifier also waits for and clicks `[data-stage-fullscreen]`, while the current slide-only Stage removed that control. | A release browser check can stall or fail for a retired UI and omit the main private surface (`docs/accessibility-matrix.md:5-15`; `scripts/verify-browser-runtime.ts:677-711,718-721`; `apps/stage/src/display-page.tsx:80-143`). |

The ledger distinguishes observed code contradictions from a runtime failure: GAP-11 and GAP-15 still need a reproduction before implementation; GAP-6 requires measurement at the final tree. Evidence-backed current capabilities are preserved and not counted as missing features.

## Components (topology ledger)

| Component | Outcome | Status | Evidence |
| --- | --- | --- | --- |
| Console | Presenter and teammate complete preparation, presentation, Q&A, and reporting | active | `apps/console/src/console-routes.tsx` |
| Stage | Audience sees a reliable, public-only presentation | active | `apps/stage/src/stage-routes.tsx` |
| Services | Ingestion, evidence, coaching, and reporting remain accurate | active | `docs/DEMO-SCOPE.md` |
| Release | Security, recovery, accessibility, and actual venue checks constrain completion | active | `docs/final-manual-qa.md` |

## Open assumptions (announced defaults)

| Assumption | Default | Rationale | Reversible? |
| --- | --- | --- | --- |
| Product boundary | Existing Windows 11 Chrome/Edge guarded-pilot modes | Documented support in `docs/DEMO-SCOPE.md` | Yes |
| Publication | Verified and explicitly approved material only; live-public remains off | Existing safety gate in `docs/DEMO-SCOPE.md` | Yes, only after recorded safety decision |
| Stage audience view | Slide-only; do not revive public cards to satisfy an obsolete rehearsal document | Latest implementation, 410 gates and Stage negative tests | Yes only as a separate security/product decision |
| Second-device pairing | Use a short-lived, non-authorizing Console invitation consumed on the separate Stage, followed by visible fingerprint confirmation and explicit presenter approval | Documented topology needs a reachable path without giving account credentials to Stage; explicitly approved after the unanswered fork | Yes, only by a later owner decision |
| Teammate scope | Add a separately authenticated session-scoped question channel with revocation, no playback/publication/report privilege by default | Direct teammate entry is a recorded key use, whereas the existing UI is presenter-only; explicitly approved after the unanswered fork | Yes, only by a later owner decision |
| Budget, provider, capacity | Preserve current 5-second recommendation gate and current providers; do not authorize paid upgrades or claim production capacity from local samples | Historical performance differs by cohort and load; no new budget granted | Yes; paid-service or threshold change requires owner decision |
| Accessibility and platforms | Keep the documented Windows 11 Chrome/Edge target, Korean/English, WCAG 2.2 AA, desktop and compact reflow | `docs/DEMO-SCOPE.md:9-27` and `apps/console/DESIGN.md:111-126` | Yes; new audience/platform targets need a separate decision |

## Findings (cited - path:lines)

- `apps/console/src/App.tsx:1-4` and `apps/stage/src/App.tsx:1-6` are barrels; actual routes must be inspected instead of planning edits against the barrels.
- `docs/DEMO-SCOPE.md:40-67` separates provisional live-recommendation gates from the default-off public evidence policy.
- `docs/final-manual-qa.md:9-19,79-111` distinguishes automated evidence from unperformed venue-hardware rehearsal; local QA cannot certify physical completion.
- `.omo/plans/ux-round2.md:1-23` is an untracked, overlapping eight-defect Console plan; `git status --short` also shows many in-progress Console edits. Preserve all pre-existing changes.
- `.omo/boulder.json:1-22` names an older paused hyperplan; do not treat it as proof that its goals have shipped.

## Decisions (with rationale)

- Intent UNCLEAR: the request identifies an ideal end-state, not a bounded feature; derive reversible defaults from evidence and present contrasting approaches before approval.
- High-accuracy review required by default after approval; plan-reviewer has not run.
- After approval, the native `plan-consultant` spawn was refused with `Agent "plan-consultant" is plan-gated: it is available only after the user explicitly requests the ulw-plan workflow in this session, and no such request was made.` Do not pretend its analysis occurred; the same gate prevents native plan-reviewer use here. Source reads and a structural self-audit will be recorded; independent review remains unapproved until the host gate is opened by a new explicit workflow request.
- Architectural advisory lane could not start because its provider lacks a key; its claims will not be treated as evidence.
- Read-only research lanes may run in parallel, but implementation and dependency-ordered mass-ulw execution are deferred to a separate explicitly started execution workflow.
- `apps/stage/src/landing-page.tsx:19-31,139-145` makes a Stage opened on a second device inert; `apps/stage/src/App.test.tsx:520-557` explicitly pins this behavior. Yet `docs/DEMO-SCOPE.md:11-30,235-239` promises a separate private controller and typed-code fallback, while `apps/console/src/audience-panel.tsx:43-48,108-143` still displays a code-approval input. This is an observed contract conflict, not proof of an accidental test regression; safe repair needs a deliberate pairing policy.
- `apps/stage/src/display-page.tsx:100-143` renders a slide-only audience view, and `services/projection-gateway/src/http.ts:397-403` and `services/private-backend/src/http/routes/playback-read.ts:11-18` explicitly disable public cards. Older `docs/final-manual-qa.md:56-57` still describes approving/retracting cards, so its venue flow cannot be used unchanged as current release evidence.
- `.omo/evidence/task-50/final-state.json` records both recommendation cohorts below 10/10 at its commit, while `.omo/evidence/task-53/receipts.json` reports both 10/10 at a later commit. `docs/DEMO-SCOPE.md:55-74` reports completion held open. No historical receipt establishes current-tree reliability or actual physical-venue completion; the execution plan must measure at the final tree before deciding which gap persists.
- `.omo/plans/ux-round2.md:1-23` targets eight Console UX defects; current `apps/console/src/workspace-page.tsx:186-244` and `apps/console/src/qa-defense-panel.tsx:107-155` already contain corresponding phase and question UX, with related files dirty. Inspect and verify these changes rather than plan duplicate edits.

## Scope IN

- User journeys, observed versus desired states, every evidenced gap, decision-complete remediation plan proposal, agent-executable QA, and 1:1 ideal-state traceability.

## Scope OUT (Must NOT have)

- No product code/test edits, implementation subagents, commits, or claims of passing physical venue QA in planning mode.
- No automatic live-public publishing, private Stage imports, weakened authorization or evidence verification.

## Open questions

- Approved owner decision (2026-09-25): short-lived Console invitation and separately authenticated teammate question-only access are both approved by "음 전부 승인." The earlier unanswered fork is superseded. No playback, microphone, publication or report grants transfer with teammate access.
- Release decision: if verified final-tree recommendation cohorts still fail the accepted 5-second/10-of-10 contract, preserving the gate yields an honest open criterion. A paid model tier or relaxed deadline requires explicit owner choice; it cannot be silently called complete.
- Environment decision: physical Windows 11, projector, separate controller, approved provider account, and observer are necessary to assert the venue/quality ideal; local macOS automation cannot replace those observations.

## Proposed execution order and delegation

This draft is a proposal, not an execution authorization. One mass-ulw workflow run per dependency-ordered phase, and a new run only after the previous phase's claims are independently checked:

1. Baseline and reproduction: protect the dirty worktree; run current checks, browser Console/Stage journey and specific failure reproductions. Read-only and bounded test probes may parallelize across Console, Stage, service, and policy/documentation, but the one final journey validator consumes all four reports. Route mechanical documentation/testing to `quick`, UI interpretation to `visual-engineering`, and cross-package security/authorization decisions to `deep-high`. No two parallel lanes write the same locale files or shared contracts.
2. Boundary and continuity: resolve approved cross-device pairing and scoped teammate authority first, then Stage receipt/recovery/asset visibility and account-isolation/rebind flows in serial where DTOs overlap; independent Stage and Console UI work may run in separate task-owned worktrees. Preserve slide-only public projection.
3. Presenter and service behavior: fix freshly reproduced STT deadline, FINAL backpressure, OCR warning/readiness, report pending/coaching and UX gaps; link each production change with its existing-owner regression test and real endpoint or browser proof. Serialize work sharing `apps/console/src/auth-session.tsx`, `apps/console/src/report-page.tsx`, or shared backend contracts.
4. Verification and release alignment: run diagnostics, owner tests, the root build/check and user-facing browser/HTTP scenarios on the integrated tree, update obsolete docs/matrix to match the shipped policy, then independently audit every IS/GAP mapping. Record a failure as a new todo rather than silently narrowing the ideal state. Physical venue, human usability and approved-provider checks remain separate named acceptance gates.

The architect advisory provider was unavailable; the decomposition above follows verified code boundaries and will be checked by the post-approval plan consultant and plan reviewer. No mass-ulw graph is launched in this planning session.

## Proposed agent-executed QA scenarios

The following are executable scenario specifications, not results. Store each action log, status+body, screenshot and teardown receipt beneath the execution loop's `currentAttemptDir`; register the file with `agentToolkit.recordEvidence` only after its exact scenario passes.

| Target rows | Exact channel and action | Binary PASS / FAIL |
| --- | --- | --- |
| IS-1, IS-3, IS-6 | Start the full stack with `bun run dev` from `scripts/dev-services.ts` (Console `http://localhost:4173`, Stage `http://localhost:4174`, private `http://127.0.0.1:3001`, public `http://127.0.0.1:3002`); use omowright to open Console `/sign-in`, sign in with the task-owned fixture, upload a representative valid PPTX then PDF and invalid/encrypted input, navigate through `/session` to `/reports/<returned-session-id>`; capture 1440x900, 1024x768, 375x812 screenshots in Korean and English. | Valid assets render ordered slides; invalid input has actionable error; transport is usable above the fold, report identifies visits without hashes, and no overflow/overlap occurs. A failed selection can be retried. |
| IS-2 | Use two isolated browser profiles (one Console, one Stage) with no `window.opener`; in Console click `[data-copy-stage]`, open the copied URL on public Stage, then use the approved one-time pairing UX and compare the visible fingerprint before binding. Also try wrong deck/fingerprint, expired/replayed join, and a forged `postMessage`. | Exactly the authorized Stage binds; none of the negative variants does; Stage never asks for Console credentials or reveals private data. One-machine popup alone is not a pass. |
| IS-4, IS-7 | In real Stage browser navigate `/display/<approved-display-id>`, change slide twice in Console, block an asset request and separately disconnect/reconnect SSE/WSS; capture DOM, screenshots, network and matched `commandId`/revision/receipt. | Audience pixels show the intended verified slide exactly once, or explicit public failure; never show private/card text or report READY over a blank asset. On reconnect no stale command replays. |
| IS-4 | `curl -i -X POST http://127.0.0.1:3002/internal/cards -H 'Authorization: Bearer local-development-token' -H 'Content-Type: application/json' -d '{}'` and `curl -i http://127.0.0.1:3002/v1/snapshot` without a display cookie; archive status line, headers and JSON body. | Authenticated card ingress is `410 stage_cards_disabled`; unauthenticated snapshot is `401`, with no private response data. |
| IS-5 | After ended session and explicit Q&A opening, type a question, record/edit one spoken question and have authorized teammate account B submit the same private question (if approved); ask an unanswerable question and retry a transient failure. Compare Stage DOM/network before and after. | Exactly the reviewed question and origin reach the private backend once, an answer has 1-3 valid citations or an honest abstention, B's permission is revocable and unrelated account C is denied; Stage has zero question/answer bytes. |
| IS-5, IS-6, IS-7 | `bun test services/private-backend/test/qa-http.test.ts services/private-backend/test/audio-ingest-http.test.ts services/private-backend/test/session-report-finalizer.test.ts apps/console/src/qa-defense-panel.test.tsx apps/console/src/presentation-report-page.test.tsx` after adding focused test cases: advance an injected clock beyond 60 seconds before a spoken clip; emit two FINAL events while the first recommendation is held on a deferred signal; report returns PENDING then FINALIZED; speaker sign-out then another account. | Every named test runs once with zero failures; fresh clip deadline, second FINAL delivery, report transition, and account isolation assertions are observed without fixed sleeps or mocks that erase the behavior under test. |
| IS-1, IS-7 | Run `uv run --project services/ingestion pytest services/ingestion/tests/test_adapters.py -k ocr` and upload scanned PDF with OCR unavailable through live `POST /v1/deck-uploads`; archive HTTP status/body and Console readiness screenshot. | The deliberately selected contract is visible and consistent: rejected with actionable `422 OCR_UNAVAILABLE`, or accepted as image-only with an explicit unsearchable-evidence warning. Never treat a rendered image as extracted evidence. |
| IS-3, IS-8 | Run `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run check:browser-boundary`, `bun run check:boundaries`, `bun run check:browser-runtime`; run Console and Stage keyboard/contrast/320px/200%-zoom checks in Chrome and Edge on supported Windows. | All actual commands exit 0 and accessibility screenshots/readouts cover authenticated Console plus public Stage; no obsolete fullscreen selector or missing Console route can be counted as coverage. |
| IS-8 | Follow the current slide-only venue checklist on actual Windows 11 displays in Extend, Duplicate and fallback, with a separate private controller and a privacy observer; capture public-only projector photographs and 10 consecutive signed venue records. | Zero private pixels and zero P0 in all 10 uninterrupted physical runs; automated tests and a Darwin screenshot do not substitute for this gate. |

Every implementation row in the eventual plan must identify its happy and failure scenarios, command and evidence path; the four final verifier rows independently check compliance, code quality, manual browser/HTTP QA and IS-1 through IS-8 fidelity. A missing result remains open, never a 100% assertion.

Browser invocation to expand into each plan task: from a JS eval cell `const {loadOmowright}=await import("/Users/gahn/.bun/install/global/node_modules/omo-ai/plugin/skills/browser/scripts/omowright.mjs"); const {omowright}=await loadOmowright(); const browser=await omowright.connectPipe({browserPath:"<installed browser executable>",browserArgs:["--no-first-run","--user-data-dir=<task-owned-profile>"],storageRoot:"<task-owned-profile>"}); const page=await browser.newTab("http://localhost:4173/sign-in"); await page.locator("[data-sign-in-username]").fill("localdemo"); await page.locator("[data-sign-in-password]").fill("demo-2026-password"); await page.locator("[data-sign-in-submit]").click(); await Bun.write("<attemptDir>/console-workspace.png",await page.screenshot());` Credentials and URLs here come from `scripts/dev-services.ts:13-30`; the executing worker must resolve the actual browser binary and allocate task-owned profile/artifact paths before running. Create another isolated profile for `http://localhost:4174/`, close each browser and remove only its owned profile afterward. Each final plan task will name its post-login selectors and expected network event; no placeholder may remain in the approved execution plan.

## Approval gate

status: approved-for-plan
The pairing and teammate questions first timed out; the user subsequently explicitly approved both decisions and writing the plan with "음 전부 승인." This authorizes plan creation and review only, not implementation.
Brief to present: recommend the complete documented secure two-device plus narrow teammate journey, not the currently broken copy-link fallback; keep slide-only Stage and current five-second guard. Contrasting pairing designs for critique: (A) Console mints a short-lived non-authorizing display invitation consumed on the separate Stage, then the presenter compares fingerprint and approves (recommended: no new public Stage self-join from a bare URL); (B) a local Stage gesture creates an expiring join/code that is manually entered and approved in Console (more room-facing setup UI). Both require negative replay/wrong-device checks and retain the public/private boundary. Do not take the same-device popup-only approach as fulfillment of the documented separate-device target.
Test strategy for implementation: reproduce each behavioral bug first, then add a targeted existing-owner regression test only where the current suite would miss it; run one scoped suite, integrated build/check, and the real browser/HTTP scenario. Prose corrections receive read-review and surface alignment, not prose-string tests.
Next action after explicit approval: create the plan skeleton, obtain gap analysis, fill all tasks and QA, then perform default high-accuracy plan review. Approval never authorizes implementation.

## Plan production and self-review receipt (2026-09-25)

- Approved scope became `.omo/plans/impromptu-ideal-experience.md` (SHA-256
  `202e3ccb45d98f5cfb9a4f89099b7f5c898fbf3b0f87b1eca331ad59ceeb0e97`
  before any later revision). It contains 23 column-zero numbered tasks, F1-F4,
  8 IS rows and 16 GAP rows, references, happy/failure QA, evidence targets,
  per-task categories and commit proposals.
- Self-review: every task has References/Acceptance/QA/Category/Commit; the
  numbered sequence is 1..23; all IS-1..8 and GAP-1..16 appear in mapping rows,
  with no placeholder wording. The two non-existent source paths cited are
  specifically new files the executor must create (`0012_team_questions.sql`
  and `run-recommendation-acceptance.ts`). No product file was edited in this
  planning turn; the worktree already contained 28 dirty product paths.
- Security self-review: the Stage URL is not authorization, approval binds
  display fingerprint and fresh epoch; teammate B may only submit a question
  for A's review, with owner-tenant ACL, revocation and no report/playback/
  publication grants. Stage remains slide-only, and F3 requires physical
  Windows/projector evidence rather than automated claims. Commits are
  proposed subjects only, not authorization to commit.
- Native `plan-consultant` and `plan-reviewer` were each attempted once and
  rejected by the host's plan gate as having no recorded explicit ulw-plan
  invocation in this session. No independent review ran or approved the plan.
  Do not reframe self-review as high-accuracy plan-reviewer approval.


## Commercial product request and review — 2026-09-27

### Product experience record

- Date: 2026-09-27.
- intent: unclear product direction; explicit request for an exhaustively detailed plan.
- review_required: true.
- status: consolidated; implementation is not authorized by this request.
- Plan: `.omo/plans/impromptu-ideal-experience.md`.
- Loop goal: `G006-plan-commercial-product-experience-a`.
- The native driver still contains an older blocked planning objective. `create_goal` refused
  replacement because an unfinished goal exists. Preserve it; do not mark that older review
  complete. The loop SDK accepted G006 without overwriting previous evidence.
- Existing product baseline: HEAD `3d99719`; numerous pre-existing Console edits and untracked
  tests. SHA-256 of `git diff -- apps services packages infra scripts tests docs README.md
  compose.production.yaml`: `a246514bbd33118707d41237c1f81732fdb1d7d3a25453604049b295e9d358b6`.
- Explicit current request authorizes writing the plan, not implementing it. Do not add a second
  permission round merely to produce the requested artifact.

## Components

1. Product positioning, navigation, phase-specific interaction.
2. Public display entry and connection, preserving private/public isolation.
3. Korean/English copy, semantics and compatibility with persisted data.
4. Honest AI readiness, Q&A, teammate access and presentation results.
5. Incremental migration and observable release acceptance.

## Decisions and assumptions

- Recommend one product entry, presenter UI and public display as separate roles, not two products.
- Keep Stage origin/build/cookie/service-worker/public-gateway boundaries.
- Preserve approved non-authorizing invitation and question-only teammate principles.
- Keep slide-only public presentation; remove obsolete publication entry from customer navigation.
- Do not globally rename `evidence`, `Stage`, contracts or database fields.
- New presentation library is a separately identified product addition, not an existing capability.
- Billing, SSO, collaborative editing, new model providers and broad new platform work are excluded.
- Retain current stack and provider choices; no paid hosting or domain purchase is authorized.
- Audience/scale assumption: presenter and question-assisting teammates in the existing project
  context; no unsupported enterprise compliance, capacity or product-market claims.

## Direct observations

- Read current source for routes, auth, pairing, report DTO/parsers/renderers and Korean catalogs.
- Deployed Console sign-in opened read-only in Bun.WebView at 1365x900 and 390x844:
  `비공개 발표 제어`, `발표자 콘솔`, `비공개 워크스페이스 입장` were visibly present.
- Deployed Stage root opened read-only at 1365x768: only
  `청중 화면은 발표자 콘솔에서 열립니다.` was visible.
- These observations do not verify authenticated workflow, separate-device pairing, AI output,
  physical projection or the proposed design. Those are future acceptance cases.
- No product source, deployment, credentials or user presentation was changed.

## Advisory and review record

- Architecture advisory `st_01a0e2ac` failed before work:
  `No API key found for anthropic-subscription.`
- Replacement advisory st_01a0e2ad and read-only explorers st_01a0e2aa/st_01a0e2ab completed. Their origin/cookie/source/copy findings were checked against source and integrated. Strict snapshot rollback and Referer-policy compatibility are explicit implementation conditions.
- Native review st_01a0e2b5 rejected the separate product amendment because IS-to-todo-to-QA mappings were missing. The canonical plan now preserves all original 23 tasks, adds product tasks 24-41, IS-9..12, an IS-1..12 coverage matrix and GAP-1..16 integration map. A matching review of this canonical artifact follows.
- No independent approval is claimed before the corrected-plan verdict.


# Wave C — `qa-console-ui` (orchestrator label: plan task 15 / GAP-6)

- Task: st_01a0e37e — rebuild the post-talk Q&A console so the transcript-expiry card is
  present and honest, the pending spoken-question state renders verbatim, synced rows match
  persisted state, and only eligible items offer ask controls with a bounded pending UI.
- Verdict: **PASS** — typecheck exit 0; all console QA suites green (43/43 focused, 59/59
  with the adjacent report/locale suites).

Note on numbering: the wave-C DAG calls this node "plan task 15", but in
`.omo/plans/impromptu-ideal-experience.md` row 15 is the Stage receipt/verifier task — a
different scope owned elsewhere. This run implements the DAG node's own task text (Q&A
console rebuild) and does not touch Stage receipts. It serves plan task 36 (post-talk
Q&A/result flow) and the audit's §(c) "teammate-question console" half adjacent to 35.

## What changed

`qa-defense-panel.tsx` was rebuilt around an explicit item model:

- **Pending clip items** — a spoken transcription becomes a `PendingClip` (`clipId`,
  immutable verbatim `transcript`, `recordedAtMs`, `askableUntilMs`, state
  PENDING/ASKING/ENDED). The clip card renders the wire transcript byte-for-byte
  (`data-qa-clip-transcript`) while the composer field it seeded stays editable.
- **Transcript-expiry card** — every live/expired clip card carries
  `data-qa-clip-expiry` + `data-qa-clip-deadline`. Deadline is the server's
  `askableUntilMs` verbatim when the wire carries one, else the console's own five-minute
  bound `QA_CLIP_ASKABLE_MS` from `recordedAtMs` — never a fabricated server claim, and the
  fallback is stated in code comments rather than implied.
- **Sync** — settled asks append `SyncedExchange` rows (`data-qa-synced-row`,
  `data-qa-origin`) rendering `AnswerCard` with the *sent* question text, matching the
  persisted ledger exchange instead of whatever the draft holds. Synced retries resubmit the
  row's own question/origin (typed asks keep `clipId: null`, clip asks bind the composer).
- **Eligibility** — the single ask control (`data-qa-submit`) is offered only while the bound
  item is eligible: a live clip or a non-empty typed draft. Expired clips
  (`now >= askableUntilMs`), emptied drafts, ended clips (discarded or `qa_not_open`), and
  in-flight asks expose no ask action and cannot submit.
- **Bounded pending UI** — asks are bounded by `QA_ASK_TIMEOUT_MS` (30 s) through an injected
  `QaConsoleClock`; expiry ticks (1 s cadence) run only while a LIVE clip exists, so
  expired/ended/absent clips schedule nothing. A timed-out ask aborts its request, resolves
  to honest `qaAskTimeout` copy, and restores the clip to PENDING (or ends it if superseded
  mid-flight — superseded clips can never be resurrected by stale async continuations, all
  transitions are guarded through `liveClipIdRef`).
- Origin rule preserved: SPOKEN survives hand-edits of the transcript (including after the
  clip settled); typing into a cleared composer starts TYPED.

## Files changed

- `apps/console/src/qa-defense-panel.tsx` — rebuilt: clip items, expiry card, synced rows,
  injected clock, bounded ask, eligibility gating. New exports `QaConsoleClock`,
  `QA_CLIP_ASKABLE_MS`, `QA_ASK_TIMEOUT_MS`.
- `apps/console/src/spoken-question-control.tsx` — `onTranscript` now receives the full
  `TRANSCRIBED` outcome so the panel sees `askableUntilMs`; no behavior change otherwise.
- `apps/console/src/qa-defense.ts` — `SpokenQuestionTranscription.TRANSCRIBED` gains
  `askableUntilMs: number | null`; parser carries a finite wire value verbatim and degrades
  absent/malformed to `null` (closed-parse discipline unchanged).
- `apps/console/src/locales/en.json`, `locales/ko.json` — new keys `qaClipExpiresIn`,
  `qaClipExpired`, `qaClipEnded`, `qaClipDiscard`, `qaAskTimeout`, `qaSyncedHeading`;
  also removed the dead `evidenceApproval` key from `en.json` (unreferenced; `ko.json` had
  already dropped it — this repaired a pre-existing locale-parity red on this branch).
- `apps/console/src/console.css` — `.console-qa__clip` card styling + quiet treatment for
  EXPIRED/ENDED states; `.console-qa__rows` grid.
- `apps/console/src/spoken-question.test.tsx` — manual-clock harness; new tests: verbatim
  pending transcript + honest expiry card, server `askableUntil` honored verbatim,
  expiry removes the ask action and blocks submit, discard ends the clip with no actions,
  `qa_not_open` ends the pending clip honestly.
- `apps/console/src/qa-defense-panel.test.tsx` — new tests: settled asks become synced rows
  carrying persisted question text verbatim and in order; in-flight ask bounded by the clock
  deadline resolves to `qaAskTimeout` with no fabricated row; empty question exposes no ask
  action. One assertion updated for the synced-rows model (retried ask now appends its own
  row rather than replacing the abstention card).
- `apps/console/src/session-client.test.ts` — new test: `transcribeQuestionClip` carries a
  server `askableUntilMs` verbatim and defaults absent/malformed to `null`.

Not touched: closed DTO parsing semantics, causal revisions, authz adjacency, idempotency,
exact-origin/CSRF, tenant ACLs, display CAS, evidence verification, private/public boundary.

## Verify output (verbatim)

`bun run typecheck` (repo root, exit 0):

```
$ tsc --noEmit && bun run --cwd packages/ui typecheck && bun run --cwd apps/console typecheck && bun run --cwd apps/stage typecheck
$ tsc --noEmit
$ tsc --noEmit
$ tsc --noEmit
```

`NODE_ENV=test bun test src/qa-defense-panel.test.tsx src/spoken-question.test.tsx src/session-client.test.ts`
(from `apps/console`, exit 0):

```
bun test v1.4.2 (744846f84)

src/session-client.test.ts:
(pass) signUp sends only username and password in the credentialed request body [0.24ms]
(pass) signUp exposes duplicate usernames as a typed registration failure [0.06ms]
(pass) signIn sends only username and password in the credentialed request body [0.03ms]
(pass) Console recommendation client calls the authenticated private HTTP route [0.04ms]
(pass) recommend maps only closed private provenance and drops unsafe external URLs [0.12ms]
(pass) createConsoleSessionClient exposes a typed uploadDeck method
(pass) uploadDeck sends a PPTX as one multipart file part over credentialed XHR [0.15ms]
(pass) uploadDeck preserves PDF filename and MIME inside the multipart file part [0.02ms]
(pass) uploadDeck strictly parses the typed 201 receipt requiring nonempty session identity [0.13ms]
(pass) uploadDeck maps closed backend rejection codes, including 413 [0.04ms]
(pass) uploadDeck maps server and non-JSON failures to deterministic error codes [0.03ms]
(pass) uploadDeck emits deterministic progress for each XHR upload progress event [0.02ms]
(pass) uploadDeck aborts the transport when the AbortSignal fires [0.05ms]
(pass) uploadDeck rejects before network when the signal is already aborted [0.01ms]
(pass) uploadDeck surfaces transport failures as typed errors
(pass) uploadDeck rejects unsupported deck inputs before any network activity [0.03ms]
(pass) session end subscribes first and awaits the exact REPORT_READY event without polling [0.21ms]
(pass) session end resolves the version-2 report carrying the qa defense section [0.09ms]
(pass) reload GET parses finalized reports and exposes owner denial without report data [0.05ms]
(pass) uploadReferenceDocuments posts every file as one credentialed multipart request [0.05ms]
(pass) uploadReferenceDocuments surfaces a closed rejection reason instead of throwing raw [0.02ms]
(pass) transcribeQuestionClip carries a server askableUntil verbatim and defaults to none [0.08ms]

src/qa-defense-panel.test.tsx:
(pass) Q&A defense panel > leads a finished presenter into Q&A from the report and never offers it mid-talk [13.31ms]
(pass) Q&A defense panel > submits one request per question and renders every citation kind as a visible source [1.96ms]
(pass) Q&A defense panel > a transient abstention keeps the draft and retries the same retained question [1.79ms]
(pass) Q&A defense panel > a terminal abstention says the materials cannot support the question and offers no retry [1.40ms]
(pass) Q&A defense panel > an ANSWERED card leads with the exact asked question [1.10ms]
(pass) Q&A defense panel > both abstention variants keep the asked question visible on the card [1.83ms]
(pass) Q&A defense panel > a settled ask becomes a synced row carrying the persisted question verbatim [1.19ms]
(pass) Q&A defense panel > an in-flight ask is bounded: it resolves to an honest timeout, never a stuck spinner [0.83ms]
(pass) Q&A defense panel > an empty question exposes no ask action [0.52ms]
(pass) Q&A defense panel > retry resubmits the retained question and the re-rendered card still shows it [1.04ms]

src/spoken-question.test.tsx:
(pass) spoken questions in the Q&A defense panel > a pressed-and-stopped recording fills the question field and never auto-submits [2.00ms]
(pass) spoken questions in the Q&A defense panel > a spoken question records origin SPOKEN and a typed one still records TYPED [2.62ms]
(pass) spoken questions in the Q&A defense panel > microphone permission denial shows honest locale copy and typing keeps working [1.28ms]
(pass) spoken questions in the Q&A defense panel > transcription failure renders its own copy and inserts no fabricated text [0.98ms]
(pass) spoken questions in the Q&A defense panel > unmounting while recording stops every MediaStream track [0.74ms]
(pass) spoken questions in the Q&A defense panel > a transcribed clip is a verbatim pending question with an honest expiry card [0.99ms]
(pass) spoken questions in the Q&A defense panel > a server-provided askableUntil replaces the console expiry bound [1.09ms]
(pass) spoken questions in the Q&A defense panel > a clip that expires while pending exposes no ask action and cannot be submitted [0.98ms]
(pass) spoken questions in the Q&A defense panel > discarding a pending clip ends it and leaves no ask or discard action [1.12ms]
(pass) spoken questions in the Q&A defense panel > a not-open refusal ends the pending clip honestly instead of leaving it askable [4.04ms]
(pass) spoken questions in the Q&A defense panel > ko and en locale catalogs keep identical key sets [0.11ms]

 43 pass
 0 fail
 225 expect() calls
Ran 43 tests across 3 files. [157.00ms]
```

Adjacent report/locale suites (same run cadence, exit 0): `locale-parity.test.ts`,
`presentation-report.test.tsx`, `presentation-report-page.test.tsx`,
`session-report-view.test.ts` → 59 pass / 0 fail across 7 files total.

## Pre-existing failures NOT caused by this change (unchanged by my diff)

- `bun test src/` (whole-directory sweep) fails en masse: happy-dom `tsx` suites clobber
  each other's globals in one Bun process (known repo issue, matches audit-map N13 family).
  Every touched/neighboring suite passes individually.
- `evidence-card.test.tsx:74` expects stale copy `출처 URL` — the dirty tree's ko.json renamed
  it to `원문 보기`; pre-existing copy/test drift, outside this task's scope.
- `biome check` flags pre-existing formatting drift in `private-api-proxy.test.ts`
  (unmodified by this task).

## Assumptions recorded

- The sibling `qa-expiry-refresh` backend contract (typed `askableUntil`) is not in this
  checkout; the console honors the field when present and enforces its own honest 5-minute
  bound when absent, so neither direction lies about the deadline.
- "Ended clip" was implemented as an explicit terminal state reached by discard or a
  `qa_not_open` ask refusal; expired and ended clips remain visible as honest records with
  no controls.
- Synced rows mirror the durable ledger exchange via the ask's wire request/response pair;
  previously persisted exchanges are already rendered verbatim by the report's Q&A section
  (`report-qa-defense.tsx`), so the console seeds no rows from report state.

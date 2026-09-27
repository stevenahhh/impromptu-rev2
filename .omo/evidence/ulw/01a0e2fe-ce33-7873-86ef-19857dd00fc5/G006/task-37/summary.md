# Task 37 / GAP-10 — presenter library list/resume

## What changed
- `packages/contracts/src/private-presentations.ts` (new): closed
  `PresentationSummarySchema`, `PresentationListResponseSchema` (opaque
  `nextCursor`), `PresentationPlaybackStateSchema`,
  `PresentationDetailResponseSchema`, `PresentationRenameRequestSchema` /
  `ResponseSchema`. Exported via `private.ts`. `prepared-evidence.ts`:
  `presentationTitle` / `updatedAtMs` added as nullable-defaulted fields on
  `PresentationSessionLifecycleSchema` (same additive backfill pattern as
  `qaStartedAtMs`; record keys unchanged, legacy snapshots restore).
- `services/private-backend/src/prepared-evidence.ts`:
  `listPresentations` (owner-only, createdAtMs desc, base64url cursor,
  `INVALID_CURSOR`), `readPresentation` (owner detail → summary + public deck
  + playback, private deck fields never in the body), `renamePresentation`
  (`INVALID_PRESENTATION_TITLE`); `#ownedPresentation` for owner-gate without
  the ACTIVE requirement; `updatedAtMs` touches on approve/takeover/setSlide/
  questions/end.
- `services/private-backend/src/http/routes/presentations.ts` (new): mounted
  before coordinator routes. `GET /v1/presentations?limit&cursor`,
  `GET /v1/presentations/:id`, `POST /v1/presentations/:id` (rename). All go
  through the existing session + exact-origin + CSRF middleware; failures map
  NOT_FOUND→404, UNAUTHORIZED→403, INVALID_*→400.
- `services/private-backend/test/presentations-http.test.ts` (new): 6 tests —
  owner isolation (foreign sees [] and 403), sign-out/re-login resume,
  legacy snapshot backfill, rename scoping + validation, pagination + opaque
  cursor rejection, cookie/origin/CSRF guards.
- Console: `presentation-library.ts` (closed parsers, JSON-first coercion for
  {presentation,publicDeck,playback}; list rejects opaque foreign shapes),
  `session-client.ts` (listPresentations/readPresentation/renamePresentation/
  takeoverPlaybackLease; approveDisplay now takes the real CAS epoch with one
  refetch-retry on 409), `auth-session.tsx` (`hydrateSession` prop → mount
  `readSession` → `restoring` gate inside RequireAuth/PublicOnly; sign-out and
  account-switch clear private state), `presentation-list-panel.tsx` +
  `presentations-page.tsx` + `/presentations` route + nav link (last item),
  workspace seeds activeIndex/CAS epoch/controlRevision from the resumed deck,
  inline rename next to resume/report links, honest error+retry state
  (failure never renders as an empty list), locale strings ko+en,
  `biome.json` ignores the gitignored `.vercel` dir.

## Verification
- `bun run typecheck` — clean (root + ui + console + stage).
- `bun run lint` — clean (522 files).
- `bun test services/private-backend/test/presentations-http.test.ts` — 6/6 pass.
- `NODE_ENV=test bun test apps/console/src/presentation-library.test.tsx` — 6/6 pass.
- `bun test packages/contracts tests/contract` — 47/47 pass.
- `bun run test:db` — full migration + RLS/tenant isolation suite passes.
- Real-surface exercise: real `main.ts` on a dedicated migrated Postgres
  (see real-surface-http.log): uploaded the real 7-slide sample PDF through
  the actual render subprocess, owner list/detail across sign-out→re-login
  with lease takeover, rename, CSRF/origin denials, deck survives a backend
  restart via the Postgres snapshot row, and the public gateway 404s the
  private route with no deck bytes anywhere.
- Pre-existing/baseline: console suite has one flaky early-rejection test
  (private-api-proxy) and backend suite has 7 failures — identical on a
  pristine HEAD worktree (unrelated DB/subprocess deps).

## Notes
- No migration needed: presentations already persist through the
  `prepared_evidence_state` snapshot; new lifecycle fields are optional with
  defaults so pre-change snapshots load unchanged.
- Titles come from the deck manifest `title` (renders from the real filename
  e.g. "impromptu-sample-deck.pdf" → "Impromptu sample deck"); rename is
  owner-only with a stable presentation title in the summary.

# team-grant — plan-8 revocable question-only teammate grant + owner inbox

Task id: `st_01a0e400`. Node `team-grant` in run `impromptu-ideal-B-recovery-20260927`.
Working tree: `/Users/gahn/projects/impromptu-rev2` on `feat/ideal-experience-deploy`
(shared integration tree; a sibling node staged unrelated `presentations` changes that
this task composes with but does not touch beyond coexistence).

## What was built

Session-scoped, revocable, question-only capability for an independently signed-in
teammate B, plus the owner's private inbox. Owner A issues a grant targeted at B's
registered username; B redeems an opaque one-use invitation (`tginv_` + 256 bits, only
its SHA-256 digest persisted), then POSTs bounded text into A's inbox. B gets a
submission receipt only — never deck, playback, report, other questions, or any
cross-tenant read. Revocation, session end and expiry reject adjacent to the write.

HTTP surface (all inside the existing exact-Origin/Referer + cookie + CSRF boundary in
`handler.ts`, dispatched before the coordinator-command fallthrough):

| Route | Role | Result |
| --- | --- | --- |
| `POST /v1/team-question-grants` | owner | 201 `{grant view + invitationToken}`; idempotent replay → 200 `{…, duplicate: true}` with **no** token |
| `DELETE /v1/team-question-grants/:id` | owner | 200 view; bumps `revocationRevision`; 404 foreign/missing |
| `GET /v1/team-question-grants?presentationSessionId=` | owner | 200 grant list, no token/digest fields |
| `POST /v1/team-question-grants/accept` | targeted teammate | 200 `{grantId, presentationSessionId, expiresAtMs}`; one-use; 404 wrong account/token; 410 revoked/expired; 409 ended |
| `POST /v1/team-questions` | accepted teammate | 202 receipt; typed 404/409/410 denials; idempotent `DUPLICATE` vs 409 conflict |
| `GET /v1/team-questions?presentationSessionId=` | owner only | 200 `{presentationSessionId, questions[]}` |

## Files

New:
- `packages/contracts/src/private-team-questions.ts` — closed Zod DTOs (`.strict()`),
  branded `tqg_`/`tqq_`/`tginv_` ids, `TEAM_QUESTION_TEXT_MAX=2000`,
  `TEAM_QUESTION_GRANT_TTL_MS=4h`; exported via `private.ts`.
- `packages/contracts/src/private-team-questions.test.ts` — closedness/bounds pins.
- `infra/migrations/private/0012_team_questions.sql` — `private_app.team_question_grants`
  (`(tenant_id, session_id)` FK → `presentation_sessions`, account-id FKs → `accounts`,
  `UNIQUE(invitation_digest)`, `UNIQUE(tenant_id, idempotency_key)`,
  `revocation_revision`, `expires_at`, `accepted_at`, `revoked_at`) and
  `private_app.team_questions` (append-only inbox, `question_seq` identity,
  `UNIQUE(tenant_id, grant_id, idempotency_key)`, FKs to session + grant + account).
  Forced RLS `tenant_isolation` on both; `teammate_target` is the single narrowly-scoped
  exception — a SELECT-only policy pinned to `app.actor_account_id` (the caller's
  authenticated account id, set transaction-locally) so B resolves only the exact grant
  aimed at it before the owner tenant context exists. No generic cross-tenant SELECT.
- `services/private-backend/src/team-question-grants.ts` — store interface +
  in-memory implementation (dev-topology/test equivalent; single-turn atomic check-and-set).
- `services/private-backend/src/team-question-grants-postgres.ts` — PostgreSQL store:
  teammate-scoped resolution under `app.actor_account_id`, then `SELECT … FOR UPDATE`
  under the grant's owner tenant for conditional accept/revoke/append; tenant/session
  provisioning mirrors `provisioned-session-report-repository` (`tenantUuidForAccount`,
  `presentationSessionUuid`).
- `services/private-backend/src/bootstrap/team-questions.ts` — service seam mirroring
  `bootstrap/qa-defense.ts`; owner resolution (`resolveOwnerPresentation`, ENDED still
  resolves so the route applies its own phase guard), teammate identity resolution before
  owner-tenant access, liveness re-check adjacent to every write.
- `services/private-backend/src/http/routes/team-questions.ts` — route module +
  `TeamQuestionRouteDependencies`; typed reason→status mapping, fail-closed 503
  `team_questions_unavailable` only when the dependency is absent and the path matches.
- `services/private-backend/test/team-questions-http.test.ts` — 18 handler-level tests.
- `services/private-backend/test/team-question-store.test.ts` — 6 store-level tests.
- `tests/database/team-question-store-integration.ts` — real-PG store exercise.

Edited:
- `packages/contracts/src/private.ts` — export `private-team-questions.ts`.
- `services/private-backend/src/http/types.ts` — optional `teamQuestions` dependency.
- `services/private-backend/src/http/handler.ts` — dispatch before the fallthrough.
- `services/private-backend/src/main.ts` — wire `createPostgresTeamQuestionStore` and the
  shared `AccountStore` (`resolveAccount`) into `createTeamQuestions`.
- `services/private-backend/src/index.ts` — export the store module for parity.
- `tests/database/private-seed.sql` — account rows + one grant/question per shape.
- `tests/database/private-app.sql` — zero-visibility without context; `app.actor_account_id`
  sees exactly its own grant, zero question rows, cannot UPDATE; tenant A reads its inbox.
- `tests/database/private-assertions.sql` — RLS/forced-RLS counts 6→8, added
  `teammate_target` policy pin, table-privilege assertions, unique digest + FK assertions,
  migration ledger count 9→12 (includes previously-unasserted 0010/0011).
- `tests/database/run.sh` — `SKIP private/0012_team_questions.sql` rerun assertion +
  invocation of the new integration script.

Not touched: `prepared-evidence.ts` coordinator internals, existing migrations, Q&A
exchange semantics, `.omo/boulder.json`; no `git add`/`commit`.

## Failing-then-passing (deterministic, defect-injection)

- Removing the `PRESENTATION_ENDED` gate in `submitQuestion` (bootstrap) →
  `session end blocks submissions and new accepts immediately` FAILED (1 fail/17 pass);
  reverted → green. `git diff` residue: none.
- Removing the `GRANT_NOT_FOR_CALLER` check in the in-memory store →
  `a stranger cannot revoke, and appends reject every inactive or foreign path` FAILED
  (a foreign append landed); reverted → green.
- The first test run also caught and fixed a real bug: `readInbox` mapped
  `submittedByAccountId` to the schema's `teammateAccountId` key (ZodError → 500).

## Verification outputs (verbatim tails + exit codes)

Focused tests — `bun test services/private-backend/test/team-questions-http.test.ts
services/private-backend/test/team-question-store.test.ts
packages/contracts/src/private-team-questions.test.ts` → **exit 0**:

     29 pass
     0 fail
     310 expect() calls

Wider focused set — `bun test` on the two new files plus `qa-http`, `account-registration-http`,
`http`, `display-invitations-http`, `prepared-evidence`, `tests/security/{multi-user-isolation,
release-security}`, `tests/contract` → **146 pass / 0 fail / 844 expect() calls / 18 files**.

`bun run typecheck` (root: tsc + packages/ui + apps/console + apps/stage) → **exit 0**.

`bunx biome check` on every changed file (plus `services/private-backend/src`,
`packages/contracts/src`, `tests/database`, `infra`) → clean; the only remaining finding
in the scanned set is a pre-existing formatting complaint in
`services/private-backend/src/retrieval/deck-corpus-preparation.ts` (unstaged dirty file
owned by a concurrent node — not in scope).

`bun run check:boundaries` → **exit 0** (`{"service":"projection-gateway","architecture":"valid"}`).

`bun run test:db` (fresh Compose cluster, tmpfs) → **exit 0**, including:

    APPLY private/0012_team_questions.sql
    …
    Migration ledger rerun verified.        (SKIP …0012… assertion now enforced)
    team question store PostgreSQL integration passed
    private tenant RLS and prepared-evidence state surface passed   (with new assertions)
    Database migrations and runtime isolation verified.

`snapshot`-style neighbors: `bun test services/private-backend/test/` full dir → 353 pass /
7 fail; all 7 are the same documented pre-existing environment failures (`ENOTFOUND
postgres` for `qa-exchange-store-postgres`, `/var/lib/impromptu` roots for
`deck-upload-main`) — identical signature to the sibling `invite-authority` run, unrelated
to this change.

## Manual observations (live HTTP, `team-grant-probe.ts`)

Real `Bun.serve` on 127.0.0.1:3499, three independently signed-in accounts through actual
TCP cookies + CSRF (in-memory stores = dev-topology equivalent; the deployed g003 demo
image predates this change). Full redacted log: `team-grant-live.txt`. Highlights:

    POST /v1/team-question-grants owner->B       -> 201 {grantId, invitationToken redacted, …}
    POST /v1/team-question-grants no-CSRF        -> 403 {"error":"csrf_rejected"}
    POST /v1/team-question-grants wrong-origin   -> 403 {"error":"origin_forbidden"}
    POST /v1/team-question-grants C on A session -> 403 {"error":"unauthorized"}
    POST /v1/team-question-grants/accept C w/ B's token -> 404 {"error":"invitation_not_found"}
    POST /v1/team-question-grants/accept B       -> 200 {grantId, presentationSessionId, expiresAtMs}
    POST …/accept B replay                       -> 409 team_grant_already_accepted
    POST /v1/team-questions B                    -> 202 {questionId, submittedAtMs, duplicate:false}
    POST /v1/team-questions B idempotent retry   -> 202 same questionId, duplicate:true
    POST /v1/team-questions C via B grant        -> 404 team_grant_not_found
    GET  /v1/team-questions B                    -> 403 unauthorized
    GET  /v1/team-questions owner                -> 200 {questions:[{…, teammateAccountId:B, questionText}]}
    DELETE grant by C                            -> 404 team_grant_not_found
    DELETE grant by owner                        -> 200 {status:"REVOKED", revocationRevision:2}
    POST /v1/team-questions B after revoke       -> 410 team_grant_revoked

Probe caveats: the probe handler omits `sessionReportRead`, so its `/report` returns 400
(fallthrough) rather than the 403 the wired handler returns — the 403 for B's report read
is pinned by the unit suite. `POST …/end` in the probe answered 404 for the same reason;
session-end gating is covered by `session end blocks submissions and new accepts
immediately` (which drives the real end route through `sessionReportRead`).

## Design notes / assumptions

- `teammateUsername` (normalized lookup via `AccountStore.readByUsername`) is the issue
  target because owners know usernames, not account ids; the resolved `accountId` is what
  the grant pins.
- `revoke`/`list`/`inbox` allow ENDED sessions deliberately (owner reviews questions after
  the talk); `issue`, `accept`, `submit` require ACTIVE. Grant rows are excluded from the
  coordinator snapshot — they live in their own RLS-guarded tables, consistent with
  `qa_exchanges` sitting outside the report CAS.
- The B→owner-tenant hop uses `app.actor_account_id` (per-transaction, from the verified
  session) — a convention new to 0012; `infra/database/README.md` documents `app.tenant_id`
  and was left unedited as documentation scope.

## Cleanup

No processes, ports or containers left running; the probe server stopped itself.
Disposable compose project from `test:db` torn down by the harness (leak check passes).
Temp debug files under /tmp removed.

# verify-recovery — read-only verification gate for plans 6/7/8 (wave-b recovery)

Task id: `st_01a0e46a`. Node `verify-recovery` in run `impromptu-ideal-B-recovery-20260927`.
Working tree: `/Users/gahn/projects/impromptu-rev2` on `feat/ideal-experience-deploy`
(shared integration tree; ~118 dirty/untracked entries, most owned by concurrent nodes).
This gate made **zero source, staging, or git changes** — evidence note only.

Inputs read: `verify-invite.md`, `invite-authority.md`, `team-grant.md` (same dir),
`.omo/plans/impromptu-ideal-experience.md` tasks 6-8, `AGENTS.md`.

## Verdicts

| Plan | Verdict | Basis |
| --- | --- | --- |
| 6 — non-authorizing Stage invitation protocol | **PASS** | All invariants confirmed in committed source by `verify-invite.md`; focused suites re-run green this session (see below). |
| 7 — private owner authority + current binding CAS | **PASS** | Owner/CAS/strict-DTO invariants hold; no `dbe_0` literal anywhere in `services/**/src` (only `?? "dbe_0"` CAS-base fallback at gateway `prepared-evidence.ts:695` + a comment). Integration suite re-run green. |
| 8 — revocable question-only teammate grant + owner inbox | **FAIL (gate-level, cosmetic)** | All functional and DB evidence is green, but `bun run lint` exits 1 on `services/private-backend/src/index.ts` — the export lines added by team-grant are not sorted per Biome `assist/source/organizeImports`. Exact failure below. |

## Exact failures

`bun run lint` → **exit 1** — `Checked 547 files … Found 2 errors. Found 3 warnings.`

- **Error 1 (plan-8 attributable):** `services/private-backend/src/index.ts:1:1`
  `assist/source/organizeImports` — team-grant inserted
  `export * from "./team-question-grants.ts";` and
  `export { createPostgresTeamQuestionStore } from "./team-question-grants-postgres.ts";`
  between `projection-http-port.ts` and `publication/outbox-dispatcher.ts`; Biome wants
  them after `retrieval/internal-retrieval.ts`. Safe fix exists; one reorder resolves it.
  **Not fixed here — read-only gate.**
- **Error 2 (unrelated, concurrent node):** `services/private-backend/src/retrieval/deck-corpus-preparation.ts`
  formatter diff — file is unstaged dirty and owned by a concurrent node (also noted
  as pre-existing in `team-grant.md`).
- **Warnings ×3 (unrelated, concurrent nodes):** `apps/stage/src/App.test.tsx:921`
  unused `stageMessages`; `apps/stage/src/stage-routes.tsx:22` unused `location`;
  `apps/stage/src/stage-routes.tsx:25` ineffective biome-ignore suppression.

## Changed-file scope audit

Attribution confirmed against `git diff`/`git status` on this shared tree:

- **plan 6 (`verify-invite`, read-only):** no changes claimed, none attributed. All listed
  files inspected are clean in `git status` (committed earlier).
- **plan 7 (`invite-authority`):** sole claimed change
  `services/private-backend/test/display-invitations-http.test.ts` — currently clean
  (committed as `a64ea5b` "test(private): prove invitation owner identity and fresh
  binding CAS"). Scope respected.
- **plan 8 (`team-grant`):** every claimed file verified present and consistent —
  new: `packages/contracts/src/private-team-questions{,.test}.ts`,
  `infra/migrations/private/0012_team_questions.sql`,
  `src/{team-question-grants.ts,team-question-grants-postgres.ts,bootstrap/team-questions.ts,http/routes/team-questions.ts}`,
  `test/{team-questions-http,team-question-store}.test.ts`,
  `tests/database/team-question-store-integration.ts`.
  edited: `contracts/src/private.ts` (one export line), `http/types.ts` (optional dep),
  `http/handler.ts` (dispatch inside the cookie+CSRF boundary, before the
  coordinator-command fallthrough), `main.ts` (Postgres store + `resolveAccount` wiring),
  `index.ts` (exports — source of the lint error), `tests/database/{private-seed,
  private-app,private-assertions}.sql`, `tests/database/run.sh` (+0012 SKIP assertion,
  +integration script invocation). No edits to coordinator internals, existing
  migrations, or Q&A exchange semantics attributable to this node.
- **Not plan 6/7/8 scope (concurrent nodes, left untouched):** `apps/console/src/
  display-invitations.ts` (task-12 Console wiring, untracked),
  `services/private-backend/test/display-invitations-integration.test.ts` (untracked
  two-service integration pin — runs green, included below for coverage),
  `private-presentations.ts` / `routes/presentations.ts` / the `prepared-evidence.ts`
  diffs (`presentationTitle`/`updatedAtMs`/`listPresentations` — sibling library node),
  `deck-corpus-preparation.ts`, all `apps/console`/`apps/stage` dirty files.

## DTO role exports and private/public boundaries

- `packages/contracts/package.json` exports `.`/`./public` → `public.ts`;
  `public.ts` is not modified and contains **zero** `team-question`/`TeamQuestion`
  references (grep). Team-question DTOs are reachable only via `./private` →
  `private.ts` → `private-team-questions.ts`. `index.ts` re-exports `./public.ts` only.
- `private-team-questions.ts`: every request/response schema is `.strict()` (closed);
  stored/listed views carry no token or digest; `invitationToken` appears only on the
  issuance response; `IssuedTeamQuestionGrantSchema` extends the view and re-stricts.
  Teammate-facing outputs are the accept receipt (`grantId, presentationSessionId,
  expiresAtMs`) and the submission receipt (`questionId, grantId, submittedAtMs,
  duplicate`) — no deck/report/inbox reads for the teammate role.
- `GET /v1/team-questions` is owner-only: non-owner resolves to `403 {"error":
  "unauthorized"}`; the module returns typed `503 team_questions_unavailable` only when
  the dependency is absent AND the path matches (fail-closed, then falls through).
- Migration `0012`: `(tenant_id, session_id)` composite FK → `presentation_sessions`,
  account-id FKs → `accounts`, `UNIQUE(invitation_digest)`, per-grant idempotency
  unique key, `question_seq GENERATED ALWAYS AS IDENTITY`, bounded `question` length.
- `check:boundaries` → `{"service":"projection-gateway","architecture":"valid"}`, exit 0.
- Display invitation side (plans 6/7): `display-invitations.ts` DTOs strict;
  `DisplayInvitationPendingView` carries fresh join identity + `displayBindingEpoch`,
  no token/digest; `DisplayApprovalSchema` has no token field (smuggling rejected
  `INVALID_DISPLAY_APPROVAL` — pinned by the plan-7 test).

## Commands run this session (verbatim tails + exit codes)

`bun run typecheck` — **exit 0** (root tsc + packages/ui + apps/console + apps/stage,
all clean).

`bun run check:boundaries` — **exit 0**:
```
{"service":"projection-gateway","architecture":"valid"}
```

`bun run lint` — **exit 1** (details above; 2 errors, 3 warnings on 547 files).

Focused invitation + grant + approval suites — **exit 0**:
```
bun test packages/contracts/src/display-invitations.test.ts \
  packages/contracts/src/private-team-questions.test.ts \
  services/projection-gateway/test/display-invitations.test.ts \
  services/private-backend/test/display-invitations-http.test.ts \
  services/private-backend/test/display-invitations-integration.test.ts \
  services/private-backend/test/team-questions-http.test.ts \
  services/private-backend/test/team-question-store.test.ts \
  services/private-backend/test/prepared-evidence.test.ts \
  services/private-backend/test/http.test.ts
 84 pass / 0 fail / 623 expect() calls / 9 files [5.44s]
```

Wider adjacent suites — **exit 0**:
```
bun test services/projection-gateway/test/prepared-evidence.test.ts \
  services/projection-gateway/test/session-http.test.ts \
  services/private-backend/test/qa-http.test.ts \
  services/private-backend/test/account-registration-http.test.ts \
  tests/security/release-security.test.ts \
  tests/security/multi-user-isolation.test.ts tests/contract
 90 pass / 0 fail / 399 expect() calls / 14 files [2.83s]
```

`bun run test:db` — **exit 0** (fresh disposable Compose cluster):
```
APPLY private/0012_team_questions.sql          (line 222 of log)
APPLY projection/0006_display_invitations.sql  (line 334)
Migration ledger rerun verified.
team question store PostgreSQL integration passed
…DENIED private_app: insert a tenant B row while scoped to tenant A (violates row-level security policy)
Database migrations and runtime isolation verified.
```
Full output archived at `/tmp/testdb-verify.log` (ephemeral); the RLS/denial and
teammate-scoped-SELECT assertions from `private-app.sql`/`private-assertions.sql` all
executed inside this run.

## Manual observations

- The lint failure is the only gate discrepancy across all three plans; it is one
  Biome-safe-fix reorder in `index.ts` and does not indicate a security or scope defect.
- Plan-8's `teammate_target` RLS exception is pinned both in SQL assertions
  (`private-assertions.sql`: SELECT-only, `qual` contains `app.actor_account_id` and
  `teammate_account_id`; inbox table admits tenant context only) and in the exercised
  `private-app.sql` run (teammate sees exactly its own grant, zero inbox rows, cannot
  UPDATE).
- `apps/console/src/display-playback.ts` still echoes `dbe_0` — task-12 scope per the
  plan; backend correctly rejects stale epochs (green tests + prior live proof).
- Pre-existing environment failures documented by sibling nodes
  (`qa-exchange-store-postgres` needs compose hostname; `deck-upload-main` needs
  `/var/lib/impromptu`) were not re-run here; every suite in this gate's scope passed.

## Cleanup

No processes, ports, or containers started or left running by this gate; `test:db`
uses a disposable compose project torn down by its harness. No source, staging, or
`.omo/boulder.json` changes. Only this evidence note was written.

# Wave B — Console-issued one-use display invitation (plan tasks 6 + 7; GAP-2, GAP-11)

Task id: st_01a0e36d. Executed in isolated checkout `/Users/gahn/.omo/wt/t653b4cae69/m` at
HEAD `3c61cb9`. No commits made; edits left in the worktree.

## What was delivered

The non-authorizing display invitation pipeline end to end:

1. **Closed wire schemas** in `packages/contracts` (new `display-invitations.ts`, exported
   from both `public` and `private` barrels): `DisplayInvitationIdSchema` (`dinvite_` +
   128-bit hex), `DisplayInvitationTokenSchema` (`dinv_` + 256-bit hex),
   `DisplayInvitationIssueRequestSchema` (internal mint request),
   `IssuedDisplayInvitationSchema` (the `{invitationId, token, deckVersion, expiresAtMs}`
   DTO from plan task 6), `PublicDisplayJoinRequestSchema` (closed `/v1/display-joins` body
   with optional `invitationToken`), `DisplayInvitationViewSchema` (gateway-internal read
   view, no token/digest), `StoredDisplayInvitationSchema` (durable record: digest only,
   `consumedAtMs` and `join` must be both-null or both-set),
   `CreateDisplayInvitationRequestSchema` /
   `CreateDisplayInvitationResponseSchema` (private route DTOs; the response adds
   `stagePath`, pinning the token to the URL fragment `/?deck=…#invite=dinv_…`), and
   `DisplayInvitationPendingViewSchema` (owner pending view carrying the authoritative
   `displayBindingEpoch`).

2. **Gateway** (`services/projection-gateway`):
   - `POST /internal/display-invitations` (service bearer only) mints a 256-bit token and
     stores only its SHA-256 digest in `store.invitations` — a new map kept out of the
     closed gateway snapshot, persisted via `snapshotDisplayInvitationState` /
     `restoreDisplayInvitationState` into a **separately versioned** state row
     (`DISPLAY_INVITATION_STATE_SNAPSHOT`), so the previous binary still restores its own
     snapshot (pinned by test).
   - `POST /v1/display-joins` accepts an optional `invitationToken`; a presented token
     resolves by digest, rejects `INVITATION_UNKNOWN` (404) / `INVITATION_EXPIRED` (410,
     exactly `now >= expiresAtMs`) / `INVITATION_CONSUMED` (409) /
     `INVITATION_DECK_MISMATCH` (409), and on success atomically consumes the invitation
     and creates exactly one pending join — no display cookie, no binding. Omitted token
     preserves the Console-opener join unchanged (existing tests green).
   - `GET /internal/display-invitations/:id` (bearer) returns the token-free view
     `{invitationId, presentationSessionId, deckVersion, expiresAtMs, status, join}`.
   - `bindDisplay` additionally pins an invitation-created join to its minted session
     (`JOIN_SESSION_MISMATCH`) — an invitation token can never slide onto a sibling or
     successor presentation.
   - Invitation TTL is hard-capped at `MAX_DISPLAY_INVITATION_TTL_MS = 90_000`; the
     constructor throws on a larger configured TTL.
   - Persistence ordering on exchange is fail-closed: `persistInvitations()` (consume mark)
     before `persist()` (join row); a torn write loses the token rather than permitting a
     replay.

3. **Private backend** (`services/private-backend`):
   - `PreparedEvidenceProjectionPort` gains `issueDisplayInvitation` /
     `readDisplayInvitation`; `ProjectionHttpPort` implements them over
     `/internal/display-invitations`.
   - `PreparedEvidenceCoordinator.issueDisplayInvitation` (owner + ACTIVE via
     `#authorizedPresentation`, deckVersion re-verified against the minted response) and
     `readDisplayInvitation` (invitation-pinned `presentationSessionId` authorizes the
     owner; response carries the authoritative `playback.displayBindingEpoch`; token and
     digest never cross the boundary).
   - `approveDisplay` now enforces the CAS **privately** before any gateway call:
     `expectedDisplayBindingEpoch` must equal the authoritative
     `playback.displayBindingEpoch`, else typed `STALE_DISPLAY_BINDING` (409). The gateway's
     own CAS (`BINDING_CAS_CONFLICT`) still stands as second line. This is the fix for
     "rebinding sends constant `dbe_0`": a stale epoch is now rejected by private authority.
   - Routes `POST /v1/display-invitations` (201 minted DTO + `stagePath`) and
     `GET /v1/display-invitations/:id/pending` (200 pending view), registered after the
     existing exact-Origin/Referer mutation gate and cookie + CSRF boundary; nothing is
     added to account/session handling.

4. **Migration**: `infra/migrations/projection/0006_display_invitations.sql` — separate
   `display_invitation_state` table + `read_invitation_state` /
   `write_invitation_state` narrow functions, `owner_internal` RLS policy, `projection_app`
   grants. Chosen over a private migration because the invitation is gateway state; the
   deliverable's "ordered after private/0011" constraint is satisfied trivially (private
   migrations untouched; no private persistence needed since the gateway record carries
   `presentationSessionId` and the coordinator re-authorizes it).

5. **DB harness updates**: `tests/database/projection-assertions.sql` (7 forced-RLS tables,
   7 `owner_internal` policies, 6 applied migrations, narrow-function privilege block for
   invitation state), `tests/database/projection-app.sql` (reads invitation state through the
   narrow function), `tests/database/run.sh` (rerun skip list gains `private/0010`,
   `private/0011`, `projection/0006` — the two private entries were already missing from the
   stale list), `tests/database/state-store-integration.ts` (invitation persistence
   reload + stale-writer conflict + token-absent-from-store check; stub port extended).

## Files changed

- `packages/contracts/src/display-invitations.ts` (new), `display-invitations.test.ts` (new)
- `packages/contracts/src/public.ts`, `private.ts` (barrel exports)
- `services/projection-gateway/src/prepared-evidence.ts` (store map, mint/exchange/read,
  invitation snapshot/restore, `JOIN_SESSION_MISMATCH`, TTL cap)
- `services/projection-gateway/src/http.ts` (internal mint/read routes, closed public join
  body, exchange path)
- `services/projection-gateway/src/ports/postgres-projection-store.ts`
  (`createPostgresDisplayInvitationPersistence`)
- `services/projection-gateway/src/main.ts` (wires `persistInvitations`)
- `services/projection-gateway/test/display-invitations.test.ts` (new)
- `services/private-backend/src/prepared-evidence.ts` (port iface + coordinator methods +
  private CAS precheck)
- `services/private-backend/src/projection-http-port.ts` (port impl)
- `services/private-backend/src/http/routes/display-invitations.ts` (new),
  `src/http/handler.ts` (registration)
- `services/private-backend/test/display-invitations-http.test.ts` (new); stub ports
  updated in `http.test.ts`, `qa-http.test.ts`, `audio-ingest-http.test.ts`
- `infra/migrations/projection/0006_display_invitations.sql` (new)
- `tests/database/{projection-assertions.sql, projection-app.sql, run.sh,
  state-store-integration.ts}`

## Verification (verbatim tails)

`bun run typecheck` → exit 0:

    $ tsc --noEmit && bun run --cwd packages/ui typecheck && bun run --cwd apps/console typecheck && bun run --cwd apps/stage typecheck
    $ tsc --noEmit
    $ tsc --noEmit
    $ tsc --noEmit

`bun test` — new suites (25/25 pass):

    (pass) display invitation contracts > the issuance response pins the token to the URL fragment
    (pass) display invitation boundary > issues a one-use invitation, exposes it to the owner, and binds it with CAS
    (pass) display invitation boundary > rejects wrong-owner issuance and pending reads before any public side effect
    (pass) display invitation boundary > an expired invitation reports EXPIRED and its exchange is refused
    (pass) display invitation boundary > a stale binding epoch is refused before the projection is touched
    (pass) display invitation boundary > a forged display identity never reaches the projection
    (pass) display invitation boundary > issuance demands the console origin, the session cookie, and CSRF
    (pass) display invitation issuance (internal) > mints a >=128-bit token, stores only its digest, and expires inside 90 seconds
    (pass) display invitation issuance (internal) > refuses issuance without the service bearer and rejects oversized TTLs
    (pass) display invitation exchange (public) > exchanges a live token for exactly one pending join locator
    (pass) display invitation exchange (public) > rejects unknown, expired, wrong-deck, and malformed tokens with typed outcomes
    (pass) display invitation exchange (public) > keeps the opener-style join without an invitation working
    (pass) display invitation exchange (public) > a post-restart replay of a consumed invitation is still rejected
    (pass) display invitation exchange (public) > an unspent invitation survives a restart inside its TTL
    (pass) display invitation read (internal) > reports pending and joined views to the service bearer only
    (pass) display invitation binding > an invited join cannot bind a different presentation session
    (pass) display invitation binding > the durable gateway snapshot keeps its previous closed shape
      25 pass / 0 fail / 136 expect() calls

`bun test services/projection-gateway` (all existing + new): `66 pass 0 fail`
`bun test` touched private suites (prepared-evidence, http, qa-http, audio-ingest-http,
session-http, account-registration-http, deck-upload-http, private-recommendation-http,
operational-controls + new): `86 pass 0 fail`

`bun run lint` → `Checked 511 files` clean.
`bun run check:boundaries` → `{"service":"projection-gateway","architecture":"valid"}`.

`bun run test:db` (full isolated docker DB run) → green; the migration applies in order and
the invitation state round-trips:

    APPLY private/0010_reference_documents.sql
    APPLY private/0011_qa_exchanges.sql
    APPLY projection/0001_projection_foundation.sql
    APPLY projection/0002_publication_inbox.sql
    APPLY projection/0003_dispatcher_only_writes.sql
    APPLY projection/0004_retention_cascade.sql
    APPLY projection/0005_gateway_state.sql
    APPLY projection/0006_display_invitations.sql
    ...
    PostgreSQL prepared-evidence state repositories verified.
    ...
    DENIED projection_app: read the gateway state base table directly (permission denied for table gateway_state)
    ...
    Database migrations and runtime isolation verified.

## Behavior proof points (from the new tests)

- Invitation joins **once**: second `POST /v1/display-joins` with the same token →
  `409 {outcome:"REJECTED", reason:"INVITATION_CONSUMED"}`; post-restart replay of the same
  token → same rejection.
- Expiry is exact: at `now == expiresAtMs` → `410 INVITATION_EXPIRED` (injected clock).
- Wrong CAS: `POST /v1/display-bindings` with `dbe_0` after a binding exists →
  `409 {"error":"STALE_DISPLAY_BINDING"}` rejected before the projection is touched; the
  fresh `dbe_1` rebind then succeeds (`dbe_2` minted).
- Wrong fingerprint → `409 DISPLAY_IDENTITY_MISMATCH`; wrong owner → 403; missing CSRF →
  `csrf_rejected`; wrong Origin → 403; no bearer on internal routes → 401.
- The stored invitation record serializes without the token (digest-only assertion), and
  the main gateway snapshot is byte-shape-identical to before (`joins`, `projections`,
  `stateKind` keys only — previous binary can restore it).

## Known pre-existing / out-of-scope failures (not caused by this change)

- Full `bun test` run: 673 pass / 178 fail. All failures sit in `apps/console` +
  `apps/stage` tsx suites (ambient `NODE_ENV=production` kills `React.act`; documented
  defect N13 in `audit-map.md`), the unimplemented pairing/product reds already mapped
  (N7–N9), `services/private-backend/test/qa-exchange-store-postgres.test.ts` (needs the
  compose `postgres` hostname — `ENOTFOUND postgres`), `deck-upload-main.test.ts` (spawns
  `src/main.ts` needing `/var/lib/impromptu` paths and a live DB), and
  `private-recommendation-http.test.ts` (passes standalone at ~4.9s against its 5s wall
  clock; flakes under serialized full-suite load).
- Console `display-playback.ts` still sends `dbe_0` on first bind — correct for a fresh
  UNBOUND presentation; the rebind fetch from the pending endpoint is Console task 12.
- Stage `createJoin` does not yet pass `invitationToken` — Stage/UI wiring is tasks 12/13.
- `test:e2e`/`test:security` not run (not in this task's VERIFY set); browser flows are
  Wave C scope.

## Assumptions recorded

- The "redacted public URL" the backend returns is realized as `stagePath`
  (`/?deck=<v>#invite=<token>`): the Console owns exact Stage-origin resolution already
  (`stage-origin.ts`), so the backend returns a fragment-token relative URL rather than
  gaining a second origin source of truth. The token is never in a query parameter.
- An invitation pins its minting `presentationSessionId`; binding that join to a different
  session is `JOIN_SESSION_MISMATCH`. This enforces "URL/locator never grants authority"
  across same-owner sibling/renewed sessions.
- Invitation exchange persists consume-mark before join row (fail closed on torn write).
- Gateway invitation state uses a dedicated versioned state row (new table mirroring
  `gateway_state`), satisfying "separately versioned … not a new field in the existing
  closed gateway snapshot" — the main snapshot's shape is unchanged and pinned by test.

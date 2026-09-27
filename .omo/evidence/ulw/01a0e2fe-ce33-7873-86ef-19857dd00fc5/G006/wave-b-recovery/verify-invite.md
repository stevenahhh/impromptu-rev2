# verify-invite — plan-6 committed invitation implementation (read-only)

Scope: confirm the invariants already on `feat/ideal-experience-deploy`; no source edits
made. Deliverable: this evidence note only.

## Invariant check (source inspection)

- **Digest-only token storage** — CONFIRMED. `PreparedEvidenceProjectionGateway.issueDisplayInvitation`
  (services/projection-gateway/src/prepared-evidence.ts ~line 516) stores
  `tokenDigest: sha256Hex(token)` in `StoredDisplayInvitationSchema`; the raw token leaves
  the process once in the `ISSUED` result. `StoredDisplayInvitationSchema`
  (packages/contracts/src/display-invitations.ts) has no token field.
- **Exact 90-second expiry ceiling** — CONFIRMED. `MAX_DISPLAY_INVITATION_TTL_MS = 90_000`;
  constructor default is the max and rejects any TTL > 90000 or non-positive
  (`invitationTtlMs > MAX_DISPLAY_INVITATION_TTL_MS` → throw). Expiry comparison is
  `nowMs >= expiresAtMs` where `expiresAtMs = issuedAt + ttl`.
- **One-use atomic consume** — CONFIRMED. `exchangeDisplayInvitation` sets `consumedAtMs`
  and `join` in the same synchronous turn that creates the locator; replay hits
  `INVITATION_CONSUMED` before any work. Stored-schema refine forces
  `consumedAtMs`/`join` to be both-null or both-set. HTTP layer persists invitation
  state before join state (consume-first, fail-closed).
- **No public authority** — CONFIRMED. `POST /v1/display-joins` with a token returns the
  join locator (201) only — no display cookie or binding. Minting lives on
  `POST /internal/display-invitations` behind `Bearer ${internalAuthToken}` (401 otherwise);
  reads on `GET /internal/display-invitations/:id` likewise bearer-gated.
- **Session-bound pending join** — CONFIRMED. The stored record pins
  `presentationSessionId`; `readDisplayInvitation` in the private coordinator re-runs
  `#authorizedPresentation` against the record's pinned session, so a token minted for one
  session cannot surface on another. Pending view carries `displayBindingEpoch` for the
  approval CAS; bind rejects `JOIN_SESSION_MISMATCH`/`WRONG_DECK`.
- **Wrong-deck / wrong-owner denial** — CONFIRMED. Exchange rejects
  `INVITATION_DECK_MISMATCH` when `invitation.deckVersion !== input.deckVersion`.
  `#authorizedPresentation` returns `UNAUTHORIZED` when
  `presentation.lifecycle.ownerAccountId !== account.value.accountId`, gating both
  issuance (`POST /v1/display-invitations`) and the pending read.
- **Migration** — CONFIRMED. `infra/migrations/projection/0006_display_invitations.sql`
  creates `public_projection.display_invitation_state` as a separately versioned snapshot
  row (previous gateway binary keeps restoring its closed snapshot), RLS forced,
  `projection_app` granted EXECUTE only on `read_invitation_state`/`write_invitation_state`
  CAS functions; revision conflict raises `serialization_failure`.

## File list (inspected, unmodified)

- packages/contracts/src/display-invitations.ts (closed DTOs, digest-only stored record)
- packages/contracts/src/display-invitations.test.ts
- services/projection-gateway/src/prepared-evidence.ts (issue/exchange/read, TTL ceiling)
- services/projection-gateway/src/http.ts (internal bearer + public join routes)
- services/projection-gateway/src/ports/postgres-projection-store.ts (CAS persistence)
- services/projection-gateway/test/display-invitations.test.ts
- services/private-backend/src/prepared-evidence.ts (owner-gated issue/read)
- services/private-backend/src/http/routes/display-invitations.ts
- services/private-backend/test/display-invitations-http.test.ts
- infra/migrations/projection/0006_display_invitations.sql

## Test output

`bun test packages/contracts/src/display-invitations.test.ts services/projection-gateway/test/display-invitations.test.ts services/private-backend/test/display-invitations-http.test.ts`

```
 25 pass
 0 fail
 136 expect() calls
Ran 25 tests across 3 files. [74.00ms]
```
Exit code: 0

Coverage highlights: digest-only storage + consume/join coupling (contracts), >=128-bit
mint + bearer refusal + oversized-TTL rejection, typed unknown/expired/wrong-deck/malformed
rejections, post-restart replay rejection of consumed token, unspent invitation surviving
restart in TTL, invited join cannot bind a different session, wrong-owner issuance/pending
denial, origin+cookie+CSRF issuance gate, stale binding epoch and forged display identity
refused before projection contact.

`bun run check:boundaries`

```
$ bun run services/projection-gateway/test/check-architecture.ts
{"service":"projection-gateway","architecture":"valid"}
```
Exit code: 0

## Cleanup

None required — no files created, modified, or deleted outside this evidence note; no
processes left running.

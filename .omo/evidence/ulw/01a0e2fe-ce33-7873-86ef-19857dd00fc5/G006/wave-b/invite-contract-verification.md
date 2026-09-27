# invite-contract-verification - st_01a0e40f

## Outcome and scope

Plan task 6 / GAP-2 service protocol verified on HEAD `94fa31c`, together with the
requested task-7 / GAP-11 owner approval and binding-CAS integration. The task brief
was stale: this checkout already contains the closed invitation contracts, private
issuance/pending routes, production ProjectionHttpPort, gateway exchange, digest-only
separate persistence, and CAS-bound approval. Those production implementations were
preserved, not reimplemented. The earlier implementation is recorded in sibling
`invite-contract.md`; its historical verification is NOT used as this run's evidence.

Added one real HTTP integration regression using two ephemeral Bun servers and the
production ProjectionHttpPort. It verifies:

- Authenticated Console issuance for the presentation's deck, lifetime <=90 seconds,
  fragment-only token transport, and owner-visible current binding epoch.
- Concurrent exchanges of one token yield exactly one 201 and one typed 409
  INVITATION_CONSUMED; only one pending join exists.
- Exchange sets no display cookie and creates no projection. A join locator cannot
  claim a display session before approval (409 display_not_approved).
- Forged fingerprint fails with DISPLAY_IDENTITY_MISMATCH and no projection.
- Explicit private approval permits a display cookie and the public deck snapshot,
  without the private text sentinel, CSRF token, or invitation token.
- Rebinding rejects the old CAS with STALE_DISPLAY_BINDING without consuming the new
  join; fresh pending-view CAS rotates dbe_1 to dbe_2 and revokes the old display.
- At exactly expiresAtMs, exchange returns typed 410 INVITATION_EXPIRED and creates
  no join.

The existing suites exercised wrong-owner and exact-origin/CSRF denials, malformed
closed DTOs, wrong deck, restart/replay restoration, and the unchanged snapshot shape.

## Every file changed by this task

1. `services/private-backend/test/display-invitations-integration.test.ts` (new).
2. `.omo/evidence/ulw/01a0e2fe-ce33-7873-86ef-19857dd00fc5/G006/wave-b/invite-contract-verification.md` (this report, new).

No production file or migration changed. No git add or commit. Pre-existing
`.omo/boulder.json` edits and all other pre-existing untracked files were left alone.

## Decisions and assumptions

- Treat the observed HEAD implementation as authoritative rather than the stale
  assertion that the invitation route does not exist. Reject duplicating or replacing
  working security-sensitive code without a reproduced defect.
- This is added coverage, not a behavioral fix; no failing-first product change is
  claimed. Initial tests passed; initial TypeScript assertion typing errors were fixed.
- The test uses fixture credential verification, real HTTP transport, real closed
  DTO parsers, real coordinator authorization and real gateway transitions. No mocked
  bind/exchange methods. Each fetch has a 2-second deadline, the test has a 10-second
  deadline, and expiry uses an injected clock. No sleeps or polling.
- Database migrations and full-stack browser/gesture rendering were not rerun. The
  new test is service-boundary proof, not browser UI or physical projector sign-off.
  It uses in-memory gateway state; restart validation comes from the existing focused
  gateway suites, not a fresh PostgreSQL deployment test.
- Both task-owned HTTP servers stop in the test's awaited finally block. The passing
  test executes that cleanup; no persistent service process was launched.

## Verification outputs (this session, verbatim)

Diagnostics on the new test after the final edit:

```text
No diagnostics found
```

`bun run typecheck` (final):

```text
$ tsc --noEmit && bun run --cwd packages/ui typecheck && bun run --cwd apps/console typecheck && bun run --cwd apps/stage typecheck
$ tsc --noEmit
$ tsc --noEmit
$ tsc --noEmit

EXIT_CODE=0
```

Related tests command (one final run, no failing/skipped tests):

```sh
bun test packages/contracts/src/display-invitations.test.ts services/private-backend/test/display-invitations-http.test.ts services/private-backend/test/display-invitations-integration.test.ts services/private-backend/test/prepared-evidence.test.ts services/private-backend/test/http.test.ts services/projection-gateway/test/display-invitations.test.ts services/projection-gateway/test/prepared-evidence.test.ts services/projection-gateway/test/session-http.test.ts
```

```text
bun test v1.4.2 (744846f84)

packages/contracts/src/display-invitations.test.ts:
(pass) display invitation contracts > identifier shapes pin the invitation id and token surfaces [0.18ms]
(pass) display invitation contracts > the internal issuance request is closed over session, deck, and clock [0.28ms]
(pass) display invitation contracts > the issued invitation carries the token exactly once and nothing else [0.12ms]
(pass) display invitation contracts > the public join request stays closed and the invitation token is optional [0.15ms]
(pass) display invitation contracts > the internal view reports status and pending join without the token [0.21ms]
(pass) display invitation contracts > the stored record keeps only a digest and couples consumption to its join [0.16ms]
(pass) display invitation contracts > the owner pending view carries the authoritative binding epoch [0.18ms]
(pass) display invitation contracts > the console create request is closed over the session id [0.05ms]
(pass) display invitation contracts > the issuance response pins the token to the URL fragment [0.10ms]

services/private-backend/test/http.test.ts:
(pass) private backend HTTP boundary > serves a minimal health response without requiring a browser origin [0.27ms]
(pass) private backend HTTP boundary > allows only the configured exact browser Origin [0.04ms]
(pass) private backend HTTP boundary > returns 410 for every authenticated Stage card transition [0.74ms]
(pass) private backend HTTP boundary > returns a closed not-found response [0.01ms]

services/private-backend/test/prepared-evidence.test.ts:
(pass) prepared evidence private coordinator > rejects every forged public-card transition before state or projection side effects [1.45ms]
(pass) prepared evidence private coordinator > rejects expired and revoked account sessions [0.05ms]
(pass) prepared evidence private coordinator > takes over an authenticated lease, supersedes pending work, and closes the old socket [0.43ms]
(pass) prepared evidence private coordinator > restores durable sessions and rejects forged candidate lifecycle identity [1.69ms]
(pass) prepared evidence private coordinator > reads and discards legacy card revisions and published candidate lifecycle on restore [0.94ms]
(pass) prepared evidence private coordinator > accepts absolute slide.set and records only the ordered Stage prefix after restart [0.68ms]
(pass) prepared evidence private coordinator > keeps curated evidence private without mutating its lifecycle or card revision [0.17ms]
(pass) prepared evidence private coordinator > denies live publication when ACL is revoked immediately before projection [0.14ms]
(pass) prepared evidence private coordinator > rejects conflicting concurrent reuse of one approval id [0.15ms]
(pass) prepared evidence private coordinator > rejects approval and termination before projection [0.08ms]
(pass) prepared evidence private coordinator > rejects concurrent supervised live approvals without an idempotency winner [1.45ms]
(pass) prepared evidence private coordinator > keeps verified live evidence private when the safety gate is fail-closed [0.31ms]
(pass) prepared evidence private coordinator > rejects approval when a rebind makes the curated candidate stale [0.21ms]
(pass) prepared evidence private coordinator > restores a legacy lifecycle snapshot without qaStartedAtMs as null [0.37ms]
(pass) prepared evidence private coordinator > beginQuestions while ACTIVE rejects PRESENTATION_NOT_ENDED and mutates nothing [0.12ms]
(pass) prepared evidence private coordinator > beginQuestions is idempotent and repeats the FIRST timestamp with no second write [0.11ms]
(pass) prepared evidence private coordinator > opening Q&A while the talk is still ACTIVE is the typed PRESENTATION_NOT_ENDED rejection [0.06ms]
(pass) prepared evidence private coordinator > beginQuestions after the talk ends succeeds: ENDED opens once and stays idempotent [0.08ms]
(pass) prepared evidence private coordinator > an ENDED session keeps its spine locked: slides still rejected, ownership still enforced [0.16ms]
(pass) prepared evidence private coordinator > opening Q&A after the talk ended preserves the ENDED lifecycle fields it stamps over [0.09ms]
(pass) prepared evidence private coordinator > a retried end by the same owner is distinguishable from a non-owner or missing presentation [0.09ms]
(pass) prepared evidence private coordinator > an open Q&A window does NOT reopen slide control on the ended talk [0.08ms]

services/private-backend/test/display-invitations-http.test.ts:
(pass) display invitation boundary > issues a one-use invitation, exposes it to the owner, and binds it with CAS [0.61ms]
(pass) display invitation boundary > rejects wrong-owner issuance and pending reads before any public side effect [0.20ms]
(pass) display invitation boundary > an expired invitation reports EXPIRED and its exchange is refused [0.15ms]
(pass) display invitation boundary > a stale binding epoch is refused before the projection is touched [0.21ms]
(pass) display invitation boundary > the pending read returns the authoritative epoch after a binding rotates [0.23ms]
(pass) display invitation boundary > a rebound display revokes the previous projection [0.22ms]
(pass) display invitation boundary > the approval body never carries invitation token material [0.54ms]
(pass) display invitation boundary > a forged display identity never reaches the projection [0.23ms]
(pass) display invitation boundary > issuance demands the console origin, the session cookie, and CSRF [0.17ms]

services/private-backend/test/display-invitations-integration.test.ts:
(pass) HTTP invitation exchange stays non-authorizing until exact-identity, current-CAS approval [7.25ms]

services/projection-gateway/test/session-http.test.ts:
(pass) Stage display session HTTP boundary > preserves shared slide runtime metadata through binding, persistence, and snapshots [0.65ms]
(pass) Stage display session HTTP boundary > issues a locator, then sets only a public display cookie after approval [0.12ms]

services/projection-gateway/test/display-invitations.test.ts:
(pass) display invitation issuance (internal) > mints a >=128-bit token, stores only its digest, and expires inside 90 seconds [0.09ms]
(pass) display invitation issuance (internal) > refuses issuance without the service bearer and rejects oversized TTLs [0.04ms]
(pass) display invitation exchange (public) > exchanges a live token for exactly one pending join locator [0.08ms]
(pass) display invitation exchange (public) > rejects unknown, expired, wrong-deck, and malformed tokens with typed outcomes [0.15ms]
(pass) display invitation exchange (public) > keeps the opener-style join without an invitation working [0.03ms]
(pass) display invitation exchange (public) > a post-restart replay of a consumed invitation is still rejected [0.07ms]
(pass) display invitation exchange (public) > an unspent invitation survives a restart inside its TTL [0.09ms]
(pass) display invitation read (internal) > reports pending and joined views to the service bearer only [0.06ms]
(pass) display invitation binding > an invited join cannot bind a different presentation session [0.02ms]
(pass) display invitation binding > the durable gateway snapshot keeps its previous closed shape [0.02ms]

services/projection-gateway/test/prepared-evidence.test.ts:
(pass) prepared evidence projection gateway > issues a 128-bit non-authorizing locator and binds it once with CAS [0.04ms]
(pass) prepared evidence projection gateway > rejects expiry, wrong deck, and unapproved display identity
(pass) prepared evidence projection gateway > closes the old binding immediately and rejects its epoch [0.03ms]
(pass) prepared evidence projection gateway > exposes no callable card projection surface and always snapshots zero cards [0.02ms]
(pass) prepared evidence projection gateway > persists ordered playback while serializing only empty legacy card fields [0.03ms]
(pass) prepared evidence projection gateway > restores durable slides, discards legacy card payloads, and rejects forged revisions [0.09ms]

 63 pass
 0 fail
 350 expect() calls
Ran 63 tests across 8 files. [64.00ms]

EXIT_CODE=0
```

`bunx biome check services/private-backend/test/display-invitations-integration.test.ts && bun run check:boundaries` (exit 0):

```text
Checked 1 file in 4ms. No fixes applied.
$ bun run services/projection-gateway/test/check-architecture.ts
{"service":"projection-gateway","architecture":"valid"}
```

## Initial validation failures (fixed, not suppressed)

Initial typecheck failed on four newly added branded-epoch assertions. Expected values
now use DisplayBindingEpochSchema.parse; there are no casts or suppressions. Verbatim:

```text
$ tsc --noEmit && bun run --cwd packages/ui typecheck && bun run --cwd apps/console typecheck && bun run --cwd apps/stage typecheck
services/private-backend/test/display-invitations-integration.test.ts(116,79): error TS2345: Argument of type 'string' is not assignable to parameter of type 'string & $brand<"DisplayBindingEpoch">'.
  Type 'string' is not assignable to type '$brand<"DisplayBindingEpoch">'.
services/private-backend/test/display-invitations-integration.test.ts(163,12): error TS2345: Argument of type 'string' is not assignable to parameter of type 'string & $brand<"DisplayBindingEpoch">'.
  Type 'string' is not assignable to type '$brand<"DisplayBindingEpoch">'.
services/private-backend/test/display-invitations-integration.test.ts(187,54): error TS2345: Argument of type 'string' is not assignable to parameter of type 'string & $brand<"DisplayBindingEpoch">'.
  Type 'string' is not assignable to type '$brand<"DisplayBindingEpoch">'.
services/private-backend/test/display-invitations-integration.test.ts(204,12): error TS2345: Argument of type 'string' is not assignable to parameter of type 'string & $brand<"DisplayBindingEpoch">'.
  Type 'string' is not assignable to type '$brand<"DisplayBindingEpoch">'.

EXIT_CODE=2
```

Initial Biome check also requested import ordering and formatting; applying Biome only
to the new test corrected both. Verbatim initial summary:

```text
Checked 1 file in 39ms. No fixes applied.
Found 2 errors.
```

Both related test executions passed 63/63; no test was deleted, skipped, or retried to
hide a failure. No full repository build, PostgreSQL run, or browser proof is claimed.

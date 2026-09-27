# invite-authority — plan-7 private owner authority for display invitation approval

Task id: st_01a0e3e0. Node `invite-authority` in run `impromptu-ideal-B-recovery-20260927`.
Working tree: `/Users/gahn/projects/impromptu-rev2` on `feat/ideal-experience-deploy`.
The original wave-b run died on a usage limit before this node ran; the sibling
`invite-contract` node (st_01a0e36d, landed as `ea83e5b`) already carried most of plan 7's
backend. This node audited the delta, confirmed the remaining plan-7 acceptance points hold,
and added the missing deterministic pins. No production code change was required; the only
source diff is one focused test file.

## Scope audit — what already existed (verified, not re-implemented)

Read first per the task brief: `POST /v1/display-invitations` +
`GET /v1/display-invitations/:id/pending` in
`services/private-backend/src/http/routes/display-invitations.ts` (registered inside the
cookie+CSRF boundary in `handler.ts`, after the exact-Origin/Referer mutation gate in
`origin-guard.ts`), `PreparedEvidenceCoordinator.issueDisplayInvitation` /
`readDisplayInvitation` / `approveDisplay` in `prepared-evidence.ts`, and
`ProjectionHttpPort` in `projection-http-port.ts`. All were committed by `ea83e5b`; nothing
was duplicated.

- **Owner sees only its pending display/deck/expiry/current CAS, never token or private
  deck** — `DisplayInvitationPendingViewSchema` (closed, `.strict()`) carries
  `invitationId, presentationSessionId, deckVersion, expiresAtMs, status,
  displayBindingEpoch, join`; `join` is the closed `DisplayJoin` (`displayJoinId`,
  `displayId`, `displayFingerprint`, `deckVersion`, `expiresAtMs`) — the fresh display
  identity plus the authoritative epoch. No token/digest/private-deck fields can survive
  the strict parse.
- **Wrong owner rejects before projection side effect** — both issuance and the pending
  read run `#authorizedPresentation` (account session live → presentation exists → ACTIVE →
  `ownerAccountId` match → `UNAUTHORIZED`). Pending read resolves owner against the
  invitation's *pinned* `presentationSessionId`, so a stranger's invitation view cannot be
  minted onto their own session.
- **Expired/replayed token rejects before any projection side effect** — by construction:
  `DisplayApprovalSchema` is a strict object with no token field, so approval cannot carry
  token material at all; token expiry/replay is decided at the public exchange
  (`INVITATION_EXPIRED` at `now >= expiresAtMs`, `INVITATION_CONSUMED` on replay, atomic
  consume+join in one synchronous turn on the gateway).
- **Stale CAS rejects before projection side effect** — `approveDisplay` compares
  `expectedDisplayBindingEpoch` to `playback.displayBindingEpoch` *before* calling
  `bindDisplay`; the gateway's own `BINDING_CAS_CONFLICT` remains second line.
- **Wrong fingerprint rejects with no projection side effect** — enforced inside gateway
  `bindDisplay`, which checks join expiry/replay/deck/`displayId`+`displayFingerprint`
  identity/invitation-session pin/CAS before its first mutation (`join.consumed = true`,
  projection write, socket close). Deliberate layering: opener joins never transit the
  private backend, so only the gateway can compare join identity — the private CAS check
  stands because the private store owns the epoch.
- **Constant `dbe_0` on backend rebind path — absent, verified.** Exhaustive grep:
  `services/**/src` contains no `dbe_0` literal (the only hit is a comment citing the old
  defect). `displayBindingEpoch(0)` appears exactly once — presentation creation, the
  correct initial epoch. `ProjectionHttpPort.bindDisplay` forwards the caller-supplied
  epoch verbatim; `/internal/display-bindings` requires the key explicitly (closed keyset).
  Gateway `?? "dbe_0"` at `prepared-evidence.ts:695` is the "no binding exists" CAS base,
  not a hardcoded bind input. The remaining `dbe_0` constant lives in
  `apps/console/src/display-playback.ts` (Console side — task 12 scope; safe now because
  the backend rejects it as stale on rebind). All `dbe_0` in `tests/` are legitimate
  first-bind CAS values.
- **Opener flow and exact-origin+CSRF preserved** — tokenless `/v1/display-joins` still
  mints a join (existing gateway tests green); mutation gate, cookie, and CSRF ordering in
  `handler.ts` untouched.

## Change made (test-only pin; RED-demonstrated)

`services/private-backend/test/display-invitations-http.test.ts` — three new tests covering
plan-7 acceptance points that had no pin. Each was proven non-vacuous by re-introducing the
defect it guards and observing a RED run, then reverting (defect injection was via file
edit, never git; `git diff` confirms zero residue in `src/`):

1. `the pending read returns the authoritative epoch after a binding rotates` — bind at
   `dbe_0` → fresh invitation → exchange → pending read must answer `dbe_1` with the *new*
   display's identity, and approving against it mints `dbe_2`. **RED proof:** temporarily
   returning `displayBindingEpoch(0)` from `readDisplayInvitation` → 1 fail, 8 pass; revert
   → green. This is the exact GAP-11 regression ("rebinding sends constant dbe_0") caught
   at the owner-facing surface.
2. `a rebound display revokes the previous projection` — after a second approval the old
   stage socket closes `REBOUND` and the superseded `audienceDisplaySessionId` can no
   longer read a snapshot. **RED proof:** commenting the `#closeSockets(...,"REBOUND")`
   call → 1 fail; revert → green.
3. `the approval body never carries invitation token material` — `POST
   /v1/display-bindings` with a smuggled `invitationToken` is rejected
   `INVALID_DISPLAY_APPROVAL` (409) and leaves the join unconsumed; a clean body then binds
   normally. **RED proof:** dropping `.strict()` from `DisplayApprovalSchema` → 1 fail
   (201); revert → green.

## Verification outputs (verbatim tails + exit codes)

`bun test services/private-backend/test/display-invitations-http.test.ts` — after changes:

    (pass) display invitation boundary > issues a one-use invitation, exposes it to the owner, and binds it with CAS [1.22ms]
    (pass) display invitation boundary > rejects wrong-owner issuance and pending reads before any public side effect [0.32ms]
    (pass) display invitation boundary > an expired invitation reports EXPIRED and its exchange is refused [0.23ms]
    (pass) display invitation boundary > a stale binding epoch is refused before the projection is touched [0.37ms]
    (pass) display invitation boundary > the pending read returns the authoritative epoch after a binding rotates [0.33ms]
    (pass) display invitation boundary > a rebound display revokes the previous projection [0.35ms]
    (pass) display invitation boundary > the approval body never carries invitation token material [0.30ms]
    (pass) display invitation boundary > a forged display identity never reaches the projection [0.33ms]
    (pass) display invitation boundary > issuance demands the console origin, the session cookie, and CSRF [0.18ms]
     9 pass / 0 fail / 56 expect() calls   → exit 0

Focused binding/invitation suites — exit 0:

    bun test services/private-backend/test/{display-invitations-http,prepared-evidence,http}.test.ts \
      packages/contracts/src/display-invitations.test.ts \
      services/projection-gateway/test/{display-invitations,session-http}.test.ts \
      tests/security/{release-security,multi-user-isolation}.test.ts
     68 pass / 0 fail / 382 expect() calls / 8 files

`bun run typecheck` — exit 0 (all four `tsc --noEmit` sub-projects clean).
`bun run check:boundaries` — exit 0, `{"service":"projection-gateway","architecture":"valid"}`.
`bunx biome check services/private-backend/test/display-invitations-http.test.ts` — clean.

`bun test services/private-backend/test/` full dir: 312 pass / 7 fail — all 7 are
pre-existing environment failures unrelated to this change: `qa-exchange-store-postgres`
needs the compose `postgres` hostname (`ENOTFOUND postgres`) and `deck-upload-main` spawns
`src/main.ts` requiring `/var/lib/impromptu` + live DB (documented in wave-b/invite-contract.md).

## Live HTTP proof — running demo stack (`impromptu-ulw-g003-demo-*`, :3001/:3002)

Exact Origin/Referer `https://impromptu-rev2-console.vercel.app` /
`https://impromptu-rev2-stage.vercel.app`, session cookie + CSRF on every mutation;
redacted receipt at `invite-authority-live.txt` beside this file.

- `POST /v1/account-sessions` → 201 (controller bootstrap account).
- `POST /v1/deck-artifacts` → 201; `POST /v1/presentation-sessions` → 201
  (`ps_890a23ac7e4be5f7caaf0224e0f316f3`).
- `POST /v1/display-invitations` → 201 with `{invitationId, token, deckVersion, expiresAtMs,
  stagePath}`; token only inside the `stagePath` fragment (`/?deck=…#invite=dinv_…`), never
  a query param.
- `GET …/pending` before exchange → 200 `{status:PENDING, displayBindingEpoch:"dbe_0",
  join:null}`.
- `POST /v1/display-joins` w/ token → 201 join locator only; **no display cookie** in the
  response (0 `set-cookie` headers).
- Token replay → `409 {"outcome":"REJECTED","reason":"INVITATION_CONSUMED"}`.
- `GET …/pending` after exchange → 200 `JOINED` carrying fresh
  `{displayId:"display_curl_probe", displayFingerprint:"fingerprint-curl-probe-display",
  displayJoinId}` + `displayBindingEpoch:"dbe_0"`.
- Approval w/ forged fingerprint → `409 {"error":"DISPLAY_IDENTITY_MISMATCH"}`; the join is
  left approvable (next step succeeds).
- Approval echoing the pending identity + `dbe_0` → 201, `binding.displayBindingEpoch:
  "dbe_1"`.
- Fresh invitation rebind: pending read now answers `dbe_1` (authoritative current CAS);
  replaying `dbe_0` → `409 STALE_DISPLAY_BINDING` and the unbound join cannot claim a
  session (`409 display_not_approved`); echoing `dbe_1` → 201 `dbe_2`.
- Negatives: issuance without CSRF → 403 `csrf_rejected`; wrong Origin → 403
  `origin_forbidden`; no cookie → 401 `account_session_required`; a separately registered
  stranger account (`account_d34d4d07…`) reading owner's pending invitation → 403
  `unauthorized`.

## Manual observations / notes

- Deployed stack DOES serve the new routes (earlier task-4 evidence predates the rebuilt
  image).
- Probe cleanup: probe presentation left ACTIVE on the demo stack — `POST
  /v1/presentation-sessions/:id/end` returned `500 SessionReportAccessDeniedError` on the
  deployed image (report-finalizer tenant resolution; pre-existing, unrelated to this
  scope — HEAD unit suite covers the end path green). Both probe sessions were revoked via
  `DELETE /v1/account-session` (200 each); the registered `invite-probe-stranger` account
  row persists (no delete API — same residue class as task-4's `boundary-probe-b`).
- Two probe invitations and one pending join remain on the gateway, all ≤90s TTL — already
  expired at read time; bound display session for `ps_890a…` persists under the owner.
- `apps/console/src/display-playback.ts` still sends `dbe_0` — safe now (backend rejects it
  stale on rebind) and explicitly task-12 Console scope per the node brief.
- `GET …/pending` for an ended presentation returns `409 presentation_ended`; an invitation
  id minted under a foreign or deleted session is rejected by owner re-authorization.

## Files

Changed (this node):
- `services/private-backend/test/display-invitations-http.test.ts` (+175: three tests above)

Inspected/verified, unmodified (all from `ea83e5b`): contracts `display-invitations.ts`,
`prepared-evidence.ts` (DisplayApproval strict DTO), gateway `prepared-evidence.ts` +
`http.ts`, private `prepared-evidence.ts`, `projection-http-port.ts`,
`http/routes/display-invitations.ts`, `http/handler.ts`, `http/origin-guard.ts`,
migration `infra/migrations/projection/0006_display_invitations.sql`.

Sibling-session dirty files observed mid-task (`private-api-proxy*`,
`verify-browser-runtime.ts`, `windows-topology.harness.ts`, `.gitignore`, `boulder.json`)
belong to a concurrent node — untouched by this task.

## Cleanup

No processes, ports, or containers started or left running by this task; temp curl artifacts
under `/tmp/invite-proof` (outside repo); redacted copy archived beside this note.

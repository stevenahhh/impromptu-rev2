import postgres from "../../services/private-backend/node_modules/postgres";

import { createPostgresTeamQuestionStore } from "../../services/private-backend/src/team-question-grants-postgres.ts";

/**
 * Real-PostgreSQL exercise of the team question store (plan task 8): tenant RLS, the
 * teammate-pinned read exception, conditional accept/revoke writes, and idempotent append
 * all run against the migrated private schema as the `private_app` role.
 *
 * Runs inside tests/database/run.sh with PRIVATE_DATABASE_URL pointing at the disposable
 * Compose cluster.
 */

const privateDatabaseUrl = Bun.env.PRIVATE_DATABASE_URL;
if (privateDatabaseUrl === undefined) {
  throw new Error("PRIVATE_DATABASE_URL is required");
}

const sql = postgres(privateDatabaseUrl, { max: 2 });

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

const OWNER_ACCOUNT = "account_db_owner_tq";
const TEAMMATE_ACCOUNT = "account_db_teammate_tq";
const STRANGER_ACCOUNT = "account_db_stranger_tq";
const SESSION_ID = `ps_${crypto.randomUUID().replaceAll("-", "")}`;

function grantDraft(overrides: Record<string, unknown> = {}) {
  return {
    grantId: `tqg_${crypto.randomUUID().replaceAll("-", "")}`,
    tenantAccountId: OWNER_ACCOUNT,
    presentationSessionId: SESSION_ID,
    ownerAccountId: OWNER_ACCOUNT,
    teammateAccountId: TEAMMATE_ACCOUNT,
    teammateUsername: "teammate-db",
    invitationTokenDigest: crypto.randomUUID().replaceAll("-", "").repeat(2),
    idempotencyKey: `issue-${crypto.randomUUID()}`,
    revocationRevision: 1,
    createdAtMs: 1_000,
    expiresAtMs: 60_000,
    acceptedAtMs: null,
    revokedAtMs: null,
    ...overrides,
  };
}

try {
  await sql`SET ROLE private_app`;

  // The account rows the foreign keys require.
  for (const accountId of [OWNER_ACCOUNT, TEAMMATE_ACCOUNT, STRANGER_ACCOUNT]) {
    await sql`
      INSERT INTO private_app.accounts (account_id, username, password_hash, created_at)
      VALUES (${accountId}, ${accountId}, 'integration-hash', now())
      ON CONFLICT (account_id) DO NOTHING
    `;
  }

  const store = createPostgresTeamQuestionStore(sql);
  const draft = grantDraft();

  const created = await store.createGrant(draft as never);
  assert(created.outcome === "CREATED", "grant insert must succeed");
  const replay = await store.createGrant(
    grantDraft({ idempotencyKey: draft.idempotencyKey }) as never,
  );
  assert(replay.outcome === "IDEMPOTENT_REPLAY", "same idempotency key must replay, not duplicate");
  const conflict = await store.createGrant(
    grantDraft({
      idempotencyKey: draft.idempotencyKey,
      teammateAccountId: STRANGER_ACCOUNT,
    }) as never,
  );
  assert(
    conflict.outcome === "REJECTED" && conflict.reason === "IDEMPOTENCY_CONFLICT",
    "a reused issue key with a different teammate must conflict",
  );

  assert(
    (await store.findGrant(OWNER_ACCOUNT, draft.grantId)) !== null,
    "the owner must find its grant",
  );
  assert(
    (await store.findGrant(STRANGER_ACCOUNT, draft.grantId)) === null,
    "a stranger must not find the grant under its own tenant scope",
  );
  assert(
    (await store.findGrantForTeammate(TEAMMATE_ACCOUNT, draft.grantId)) !== null,
    "the targeted teammate must resolve its grant under actor context",
  );
  assert(
    (await store.findGrantForTeammate(STRANGER_ACCOUNT, draft.grantId)) === null,
    "the teammate-pinned read must not expose another account's grant",
  );
  assert(
    (await store.findGrantByInvitationDigest(TEAMMATE_ACCOUNT, draft.invitationTokenDigest)) !==
      null,
    "the targeted teammate must redeem the invitation digest",
  );
  assert(
    (await store.findGrantByInvitationDigest(STRANGER_ACCOUNT, draft.invitationTokenDigest)) ===
      null,
    "the digest alone must not resolve for another account",
  );

  // Concurrent redemptions: exactly one acceptance may land.
  const [firstAccept, secondAccept] = await Promise.all([
    store.acceptGrant(
      {
        tenantAccountId: OWNER_ACCOUNT,
        grantId: draft.grantId,
        teammateAccountId: TEAMMATE_ACCOUNT,
      },
      2_000,
    ),
    store.acceptGrant(
      {
        tenantAccountId: OWNER_ACCOUNT,
        grantId: draft.grantId,
        teammateAccountId: TEAMMATE_ACCOUNT,
      },
      2_000,
    ),
  ]);
  assert(
    [firstAccept.outcome, secondAccept.outcome].sort().join(",") === "ACCEPTED,REJECTED",
    "concurrent invitation redemption must yield exactly one acceptance",
  );

  const earlyStranger = await store.appendQuestion({
    grantId: draft.grantId,
    submitterAccountId: STRANGER_ACCOUNT,
    questionId: `tqq_${crypto.randomUUID().replaceAll("-", "")}`,
    questionText: "foreign append",
    idempotencyKey: "q-foreign",
    nowMs: 3_000,
  });
  assert(
    earlyStranger.outcome === "REJECTED",
    "a stranger's append must never reach the owner tenant",
  );

  const appended = await store.appendQuestion({
    grantId: draft.grantId,
    submitterAccountId: TEAMMATE_ACCOUNT,
    questionId: `tqq_${crypto.randomUUID().replaceAll("-", "")}`,
    questionText: "db question one",
    idempotencyKey: "q-1",
    nowMs: 3_000,
  });
  assert(appended.outcome === "APPENDED", "the accepted teammate's question must append");

  const duplicate = await store.appendQuestion({
    grantId: draft.grantId,
    submitterAccountId: TEAMMATE_ACCOUNT,
    questionId: `tqq_${crypto.randomUUID().replaceAll("-", "")}`,
    questionText: "db question one",
    idempotencyKey: "q-1",
    nowMs: 3_100,
  });
  assert(duplicate.outcome === "DUPLICATE", "a byte-equal retry must dedupe");
  if (duplicate.outcome === "DUPLICATE" && appended.outcome === "APPENDED") {
    assert(
      duplicate.question.questionId === appended.question.questionId,
      "the replayed receipt must carry the original question id",
    );
  }
  const idConflict = await store.appendQuestion({
    grantId: draft.grantId,
    submitterAccountId: TEAMMATE_ACCOUNT,
    questionId: `tqq_${crypto.randomUUID().replaceAll("-", "")}`,
    questionText: "different text, same key",
    idempotencyKey: "q-1",
    nowMs: 3_200,
  });
  assert(
    idConflict.outcome === "REJECTED" && idConflict.reason === "IDEMPOTENCY_CONFLICT",
    "a reused question key with different content must conflict",
  );

  const inbox = await store.readInbox(OWNER_ACCOUNT, SESSION_ID);
  assert(
    inbox.length === 1 && inbox[0]?.questionText === "db question one",
    "the owner inbox must hold exactly the recorded question",
  );
  assert(
    (await store.readInbox(STRANGER_ACCOUNT, SESSION_ID)).length === 0,
    "another tenant's inbox read must return no rows",
  );

  // Revocation: the conditional update bumps the revision once and blocks the next append
  // in the same transaction discipline the in-memory store models.
  const revoked = await store.revokeGrant(OWNER_ACCOUNT, draft.grantId, 4_000);
  assert(
    revoked.outcome === "REVOKED" && revoked.grant.revocationRevision === 2,
    "revocation must bump the revision exactly once",
  );
  const again = await store.revokeGrant(OWNER_ACCOUNT, draft.grantId, 4_100);
  assert(
    again.outcome === "ALREADY_REVOKED" && again.grant.revocationRevision === 2,
    "a second revoke must not bump the revision",
  );
  const postRevoke = await store.appendQuestion({
    grantId: draft.grantId,
    submitterAccountId: TEAMMATE_ACCOUNT,
    questionId: `tqq_${crypto.randomUUID().replaceAll("-", "")}`,
    questionText: "post-revoke",
    idempotencyKey: "q-2",
    nowMs: 4_200,
  });
  assert(
    postRevoke.outcome === "REJECTED" && postRevoke.reason === "GRANT_REVOKED",
    "a revoked grant must reject the adjacent append",
  );
  const strangerRevoke = await store.revokeGrant(STRANGER_ACCOUNT, draft.grantId, 4_300);
  assert(
    strangerRevoke.outcome === "REJECTED" && strangerRevoke.reason === "GRANT_UNKNOWN",
    "a stranger's revoke must see no grant",
  );
  console.log("team question store PostgreSQL integration passed");
} finally {
  await sql.end({ timeout: 0 });
}

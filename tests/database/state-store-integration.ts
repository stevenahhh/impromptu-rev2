import { SQL } from "bun";
import { PreparedEvidenceCoordinator } from "../../services/private-backend/src/prepared-evidence.ts";
import { createPostgresPreparedEvidencePersistence } from "../../services/private-backend/src/prepared-evidence-store-postgres.ts";
import {
  createPostgresDisplayInvitationPersistence,
  createPostgresProjectionGatewayPersistence,
} from "../../services/projection-gateway/src/ports/postgres-projection-store.ts";
import { PreparedEvidenceProjectionGateway } from "../../services/projection-gateway/src/prepared-evidence.ts";

const privateDatabaseUrl = Bun.env.PRIVATE_DATABASE_URL;
const projectionDatabaseUrl = Bun.env.PROJECTION_DATABASE_URL;
if (privateDatabaseUrl === undefined || projectionDatabaseUrl === undefined) {
  throw new Error("PRIVATE_DATABASE_URL and PROJECTION_DATABASE_URL are required");
}

const privateSql = new SQL(privateDatabaseUrl, { max: 2 });
const projectionSql = new SQL(projectionDatabaseUrl, { max: 2 });

const projectionStub = {
  bindDisplay() {
    return { outcome: "REJECTED" as const, reason: "unused" };
  },
  projectPlayback() {
    return false;
  },
  recordPlaybackApplied() {
    return false;
  },
  issueDisplayInvitation() {
    return { outcome: "REJECTED" as const, reason: "unused" };
  },
  readDisplayInvitation() {
    return { outcome: "REJECTED" as const, reason: "unused" };
  },
};

try {
  const privateFirst = await createPostgresPreparedEvidencePersistence(privateSql, {
    stateKey: "database-test",
  });
  const privateStale = await createPostgresPreparedEvidencePersistence(privateSql, {
    stateKey: "database-test",
  });
  const coordinator = new PreparedEvidenceCoordinator(projectionStub, privateFirst.store);
  const account = await coordinator.createAccountSession(
    { accountId: "account_database_test", actorId: "actor_database_test" },
    Date.now(),
  );
  await privateFirst.persist();

  const privateRestored = await createPostgresPreparedEvidencePersistence(privateSql, {
    stateKey: "database-test",
  });
  if (!privateRestored.store.accountSessions.has(account.accountSessionId)) {
    throw new Error("private prepared-evidence state did not survive a repository reload");
  }
  await expectConflict(() => privateStale.persist(), "private");

  const projectionFirst = await createPostgresProjectionGatewayPersistence(projectionSql, {
    stateKey: "database-test",
  });
  const projectionStale = await createPostgresProjectionGatewayPersistence(projectionSql, {
    stateKey: "database-test",
  });
  const gateway = new PreparedEvidenceProjectionGateway(projectionFirst.store);
  const join = gateway.createDisplayJoin(
    {
      displayId: "display_database_test",
      deckVersion: "deck_database_test",
      displayFingerprint: "database-test-fingerprint",
    },
    Date.now(),
  );
  await projectionFirst.persist();

  const projectionRestored = await createPostgresProjectionGatewayPersistence(projectionSql, {
    stateKey: "database-test",
  });
  if (!projectionRestored.store.joins.has(join.displayJoinId)) {
    throw new Error("projection gateway state did not survive a repository reload");
  }
  await expectConflict(() => projectionStale.persist(), "projection");

  const invitationFirst = await createPostgresDisplayInvitationPersistence(
    projectionSql,
    projectionFirst.store,
    { stateKey: "database-test" },
  );
  const invitationStale = await createPostgresDisplayInvitationPersistence(
    projectionSql,
    projectionFirst.store,
    { stateKey: "database-test" },
  );
  const issued = gateway.issueDisplayInvitation(
    { presentationSessionId: "ps_database_test", deckVersion: "deck_database_test" },
    Date.now(),
  );
  if (issued.outcome !== "ISSUED") {
    throw new Error("display invitation issuance failed in the state test fixture");
  }
  await invitationFirst.persist();
  if (!projectionFirst.store.invitations.has(issued.invitation.invitationId)) {
    throw new Error("display invitation was not recorded in the gateway store");
  }
  if (
    JSON.stringify([...projectionFirst.store.invitations.values()]).includes(
      issued.invitation.token,
    )
  ) {
    throw new Error("display invitation token leaked into persisted state");
  }

  const invitationRestored = await createPostgresDisplayInvitationPersistence(
    projectionSql,
    projectionRestored.store,
    { stateKey: "database-test" },
  );
  await invitationRestored.persist();
  if (!projectionRestored.store.invitations.has(issued.invitation.invitationId)) {
    throw new Error("display invitation state did not survive a repository reload");
  }
  await expectConflict(() => invitationStale.persist(), "display invitation");

  console.log("PostgreSQL prepared-evidence state repositories verified.");
} finally {
  await Promise.all([privateSql.close(), projectionSql.close()]);
}

async function expectConflict(operation: () => Promise<void>, label: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "PREPARED_EVIDENCE_STATE_CONFLICT"
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`${label} repository accepted a stale state overwrite`);
}

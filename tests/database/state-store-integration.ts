import { SQL } from "bun";
import { PreparedEvidenceCoordinator } from "../../services/private-backend/src/prepared-evidence.ts";
import { createPostgresPreparedEvidencePersistence } from "../../services/private-backend/src/prepared-evidence-store-postgres.ts";
import { createPostgresProjectionGatewayPersistence } from "../../services/projection-gateway/src/ports/postgres-projection-store.ts";
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
  projectCard() {
    return false;
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

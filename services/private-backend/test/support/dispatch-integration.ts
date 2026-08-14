import postgres from "postgres";
import {
  createPostgresPrivatePublicationOutbox,
  createPostgresProjectionDispatchBoundary,
  dispatchPublicationOutboxBatch,
  type ProjectionDispatchBoundary,
} from "../../src/index.ts";

const privateDatabaseUrl = process.env.PRIVATE_DATABASE_URL;
const projectionDatabaseUrl = process.env.PROJECTION_DATABASE_URL;
const mode = process.argv[2];

if (privateDatabaseUrl === undefined || projectionDatabaseUrl === undefined) {
  throw new Error("database integration URLs are required");
}
if (mode !== "valid" && mode !== "crash" && mode !== "replay") {
  throw new Error("dispatch integration mode must be valid, crash, or replay");
}

const privateSql = postgres(privateDatabaseUrl, { max: 1 });
const projectionSql = postgres(projectionDatabaseUrl, { max: 1 });

await privateSql`SET ROLE publication_dispatcher`;
await projectionSql`SET ROLE publication_dispatcher`;

const outbox = createPostgresPrivatePublicationOutbox(privateSql);
const postgresProjection = createPostgresProjectionDispatchBoundary(projectionSql);
let projection: ProjectionDispatchBoundary = postgresProjection;

if (mode === "crash") {
  projection = {
    async dispatch(message) {
      await postgresProjection.dispatch(message);
      process.exit(86);
    },
  };
}

const result = await dispatchPublicationOutboxBatch(outbox, projection, 1);
const expected =
  mode === "valid"
    ? { claimed: 1, applied: 1, duplicates: 0 }
    : { claimed: 1, applied: 0, duplicates: 1 };

if (JSON.stringify(result) !== JSON.stringify(expected)) {
  throw new Error(`unexpected ${mode} dispatch result: ${JSON.stringify(result)}`);
}

await Promise.all([privateSql.end(), projectionSql.end()]);
console.log(`Real PostgreSQL ${mode} dispatch verified.`);

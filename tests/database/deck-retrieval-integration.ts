import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetrievalRequestSchema } from "@impromptu/contracts/retrieval";
import postgres from "../../services/private-backend/node_modules/postgres";
import { PostgresDeckRetrievalStore } from "../../services/private-backend/src/retrieval/postgres-deck-retrieval.ts";
import { createTenantScopedPostgresRepository } from "../../services/private-backend/src/retrieval/tenant-scoped-postgres-repository.ts";

const databaseUrl = Bun.env.PRIVATE_DATABASE_URL;
if (databaseUrl === undefined) throw new Error("PRIVATE_DATABASE_URL is required");

const sql = postgres(databaseUrl, { max: 1 });
const artifactRoot = await mkdtemp(join(tmpdir(), "deck-retrieval-db-"));
const artifactDir = join(artifactRoot, "artifact");
const deckHash = "1".repeat(64);
const slideHash = "2".repeat(64);
const slideKey = `slide_${"3".repeat(64)}`;
const tenantId = "tenant-transactional-replace";
const principal = {
  tenantId,
  principalId: "database-integration",
  groupIds: [],
  attributes: {},
};
const renderManifest = {
  deck_id: `deck_${deckHash}`,
  renderer: { name: "libreoffice", version: "7.6" },
  slides: [
    {
      slide_key: slideKey,
      source_index: 1,
      relative_path: "slides/slide-1.svg",
      content_sha256: slideHash,
      width_points: 960,
      height_points: 540,
    },
  ],
  assets: [],
  fonts: [],
  timelines: [],
  mapping_issues: [],
  animation_eligible: true,
  ineligible_reason: null,
};
const manifestHash = createHash("sha256")
  .update(`render-manifest:${renderManifest.deck_id}:${slideHash}`)
  .digest("hex");
const request = RetrievalRequestSchema.parse({
  query: "transactional replace",
  deckVersion: renderManifest.deck_id,
  manifestHash,
  maxResults: 3,
});

function ingestionManifest(text: string) {
  return {
    status: "completed",
    job_id: "database-retrieval-test",
    manifest_hash: "4".repeat(64),
    manifest: {
      schema_version: "1",
      deck_id: renderManifest.deck_id,
      source_sha256: deckHash,
      source_kind: "pptx",
      adapter_version: "database-test",
      slides: [
        {
          slide_key: slideKey,
          source_index: 1,
          source_id: "ppt/slides/slide1.xml",
          width_points: 960,
          height_points: 540,
          elements: [
            {
              element_id: "text-1",
              kind: "text",
              x: 0,
              y: 0,
              width: 100,
              height: 20,
              text,
            },
          ],
          warnings: [],
        },
      ],
      render_boundary: {
        status: "not_performed",
        renderer: null,
        fidelity_verified: false,
        reason: "database integration fixture",
      },
    },
  };
}

try {
  await mkdir(join(artifactDir, "slides"), { recursive: true });
  await writeFile(join(artifactDir, "render.json"), JSON.stringify(renderManifest));
  await writeFile(
    join(artifactDir, "slides/slide-1.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><text>legacy retrieval row</text></svg>',
  );
  await writeFile(
    join(artifactDir, "ingestion.json"),
    JSON.stringify(ingestionManifest("legacy retrieval row")),
  );

  await sql`SET ROLE private_app`;
  const repository = createTenantScopedPostgresRepository(sql);
  let rejectSecondInsert = false;
  let embeddingIndex = 0;
  const store = new PostgresDeckRetrievalStore({
    repository,
    artifactRoot,
    access: {
      async authorize() {
        return true;
      },
    },
    embedding: {
      async embed() {
        const index = embeddingIndex;
        embeddingIndex += 1;
        return Array.from({ length: rejectSecondInsert && index === 1 ? 767 : 768 }, () => 0.25);
      },
    },
  });

  await store.prepare(principal, request);
  const initialRows = await repository.transaction(
    tenantId,
    async (transactionSql) =>
      transactionSql<
        readonly { object_id: string; source_revision: string; source_hash: string }[]
      >`
      SELECT object_id, source_revision, source_hash
      FROM private_app.deck_retrieval_chunks
      WHERE tenant_id = ${tenantId} AND deck_version = ${request.deckVersion}
      ORDER BY object_id
    `,
  );
  if (initialRows.length !== 1 || initialRows[0]?.source_revision !== deckHash) {
    throw new Error("initial retrieval row did not preserve the DeckManifest source revision");
  }
  if (initialRows[0]?.source_hash === deckHash) {
    throw new Error("chunk content hash was not kept separate from the source revision");
  }
  const oldObjectId = initialRows[0]?.object_id;
  if (oldObjectId === undefined) throw new Error("initial retrieval object id was missing");

  const replacementText = `${"replacement ".repeat(200)}tail`;
  await writeFile(
    join(artifactDir, "ingestion.json"),
    JSON.stringify(ingestionManifest(replacementText)),
  );
  await writeFile(
    join(artifactDir, "slides/slide-1.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg"><text>${replacementText}</text></svg>`,
  );
  rejectSecondInsert = true;
  embeddingIndex = 0;
  let replacementRejected = false;
  try {
    await store.prepare(principal, request);
  } catch (error) {
    replacementRejected =
      error instanceof Error && error.message.includes("embedding_dimension_check");
  }
  if (!replacementRejected) throw new Error("invalid replacement unexpectedly committed");

  const rowsAfterRollback = await repository.transaction(
    tenantId,
    async (transactionSql) =>
      transactionSql<readonly { object_id: string }[]>`
      SELECT object_id
      FROM private_app.deck_retrieval_chunks
      WHERE tenant_id = ${tenantId} AND deck_version = ${request.deckVersion}
    `,
  );
  if (rowsAfterRollback.length !== 1 || rowsAfterRollback[0]?.object_id !== oldObjectId) {
    throw new Error("failed replacement did not roll back to the old retrieval rows");
  }

  rejectSecondInsert = false;
  embeddingIndex = 0;
  await store.prepare(principal, request);
  const replacedRows = await repository.transaction(
    tenantId,
    async (transactionSql) =>
      transactionSql<readonly { object_id: string; source_revision: string }[]>`
      SELECT object_id, source_revision
      FROM private_app.deck_retrieval_chunks
      WHERE tenant_id = ${tenantId} AND deck_version = ${request.deckVersion}
      ORDER BY object_id
    `,
  );
  if (
    replacedRows.length !== 2 ||
    replacedRows.some((row) => row.object_id === oldObjectId || row.source_revision !== deckHash)
  ) {
    throw new Error("successful replacement did not atomically install every new retrieval row");
  }

  const missingContext = await sql<readonly { count: number }[]>`
    SELECT count(*)::integer AS count
    FROM private_app.deck_retrieval_chunks
  `;
  if (missingContext[0]?.count !== 0) {
    throw new Error("transaction-local tenant context leaked after repository completion");
  }

  console.log("Deck retrieval source revisions and transactional replacement verified.");
} finally {
  await sql.end();
  await rm(artifactRoot, { recursive: true, force: true });
}

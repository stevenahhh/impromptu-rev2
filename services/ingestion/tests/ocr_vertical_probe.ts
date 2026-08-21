import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "../../private-backend/node_modules/postgres";
import {
  createDeckRenderSubprocess,
  IngestionJsonSchema,
  RenderJsonSchema,
} from "../../private-backend/src/deck-render-subprocess.ts";
import { createDeckUploadWorker } from "../../private-backend/src/deck-upload-worker.ts";
import { InternalRetrievalService } from "../../private-backend/src/retrieval/internal-retrieval.ts";
import { PostgresDeckRetrievalStore } from "../../private-backend/src/retrieval/postgres-deck-retrieval.ts";
import { createTenantScopedPostgresRepository } from "../../private-backend/src/retrieval/tenant-scoped-postgres-repository.ts";

const EXPECTED_SENTINEL = "형식 중립 근거 자료 2026";
const fixture = resolve(
  process.env.OCR_FIXTURE_PATH ?? "tests/fixtures/format-neutral-decks/korean-scanned.pdf",
);
const ingestionProject = resolve(process.env.INGESTION_PROJECT_PATH ?? "services/ingestion");
const databaseUrl = process.env.PRIVATE_DATABASE_URL;
if (databaseUrl === undefined) throw new Error("PRIVATE_DATABASE_URL is required");

const root = mkdtempSync(join(tmpdir(), "ocr-vertical-"));
const stagingRoot = join(root, "staging");
const artifactRoot = join(root, "artifacts");
await Promise.all([
  Bun.write(join(stagingRoot, ".keep"), ""),
  Bun.write(join(artifactRoot, ".keep"), ""),
]);
const sql = postgres(databaseUrl);
const repository = createTenantScopedPostgresRepository(sql);
const tenantId = `ocr-task-26-${crypto.randomUUID()}`;
const principal = {
  tenantId,
  principalId: "ocr-task-26-principal",
  groupIds: [],
  attributes: {},
};
const fixedVector = [1, ...Array.from({ length: 767 }, () => 0)];

try {
  const upload = createDeckUploadWorker({
    subprocess: createDeckRenderSubprocess({ ingestionProject }),
    stagingRoot,
    artifactRoot,
    deadlineMs: 120_000,
  });
  const outcome = await upload.processUpload({
    fileName: "korean-scanned.pdf",
    byteLength: Bun.file(fixture).size,
    content: Bun.file(fixture).stream(),
  });
  if (outcome.outcome !== "RENDERED") {
    throw new Error(`scanned upload was rejected: ${outcome.code}`);
  }

  const artifactDir = join(artifactRoot, outcome.artifactId);
  const render = RenderJsonSchema.parse(
    JSON.parse(readFileSync(join(artifactDir, "render.json"), "utf8")),
  );
  const ingestion = IngestionJsonSchema.parse(
    JSON.parse(readFileSync(join(artifactDir, "ingestion.json"), "utf8")),
  );
  const orderedSlides = [...render.slides].sort(
    (left, right) => left.source_index - right.source_index,
  );
  const manifestHash = createHash("sha256")
    .update(
      `render-manifest:${render.deck_id}:${orderedSlides.map((slide) => slide.content_sha256).join(":")}`,
      "utf8",
    )
    .digest("hex");
  const request = {
    query: EXPECTED_SENTINEL,
    deckVersion: render.deck_id,
    manifestHash,
    maxResults: 3,
  };

  const retrieval = new PostgresDeckRetrievalStore({
    repository,
    artifactRoot,
    embedding: {
      async embed() {
        return fixedVector;
      },
    },
    access: {
      async authorize() {
        return true;
      },
    },
  });
  const service = new InternalRetrievalService({
    principals: {
      async resolve(accountSessionId) {
        return accountSessionId === "ocr-task-26-session" ? principal : null;
      },
    },
    policy: retrieval,
    ann: retrieval,
    objects: retrieval,
    corpus: retrieval,
  });
  const results = await service.retrieve("ocr-task-26-session", request, fixedVector);
  const rows = await repository.transaction(
    tenantId,
    async (transactionSql) => transactionSql<
      readonly { anchor: string; content: string; object_id: string; lexical_match: boolean }[]
    >`
      SELECT anchor, content, object_id,
        search_vector @@ plainto_tsquery('simple', ${EXPECTED_SENTINEL}) AS lexical_match
      FROM private_app.deck_retrieval_chunks
      WHERE tenant_id = ${tenantId} AND deck_version = ${render.deck_id}
      ORDER BY anchor
    `,
  );
  const textElements = ingestion.manifest.slides.flatMap((slide) =>
    slide.elements.filter((element) => element.kind === "text"),
  );
  const recognizedChunk = textElements.map((element) => element.text).join(" ");
  const expectedResult = results.find((result) => result.object.anchor === "slide=1&chunk=1");
  const receipt = {
    schemaVersion: 1,
    fixture,
    upload: {
      outcome: outcome.outcome,
      artifactId: outcome.artifactId,
      warningCodes: ingestion.manifest.slides.flatMap((slide) =>
        slide.warnings.map((warning) => warning.code),
      ),
    },
    ocr: {
      expectedSentinel: EXPECTED_SENTINEL,
      textElements,
      recognizedChunk,
      exactSentinel: recognizedChunk === EXPECTED_SENTINEL,
    },
    indexing: {
      dbChunkCount: rows.length,
      rows,
    },
    hybridQuery: {
      query: EXPECTED_SENTINEL,
      resultCount: results.length,
      results: results.map((result) => ({
        anchor: result.object.anchor,
        objectId: result.object.objectId,
        sourceId: result.object.sourceId,
        title: result.object.title,
      })),
      expectedSlideChunkReturned: expectedResult !== undefined,
      lexicalMatch: rows.some((row) => row.lexical_match),
      denseVectorDimension: fixedVector.length,
    },
  };
  console.log(JSON.stringify(receipt));
  if (
    receipt.upload.warningCodes.join(",") !== "ocr_applied" ||
    receipt.indexing.dbChunkCount !== 1 ||
    !receipt.hybridQuery.expectedSlideChunkReturned
  ) {
    process.exitCode = 1;
  }
} finally {
  await repository.transaction(tenantId, async (transactionSql) => {
    await transactionSql`DELETE FROM private_app.deck_retrieval_chunks WHERE tenant_id = ${tenantId}`;
  });
  await sql.end();
  rmSync(root, { recursive: true, force: true });
}

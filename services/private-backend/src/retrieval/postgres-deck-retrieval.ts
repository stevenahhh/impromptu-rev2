import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RetrievalRequest } from "@impromptu/contracts/retrieval";
import type { Sql } from "postgres";
import {
  type IngestionJson,
  IngestionJsonSchema,
  RenderJsonSchema,
} from "../deck-render-subprocess.ts";
import type {
  AnnCandidate,
  AuthorizedAnnIndex,
  PrivateRetrievalObjectStore,
  RetrievalAuthorizationPolicy,
  RetrievalCorpusPreparer,
  RetrievalObjectMetadata,
  RetrievalPrincipal,
} from "./internal-retrieval.ts";
import type { TenantScopedPostgresRepository } from "./tenant-scoped-postgres-repository.ts";

const AUTHORIZATION_VERSION = "acl-1";
export const DECK_CORPUS_KIND = "DECK_SLIDE";
export const REFERENCE_DOCUMENT_CORPUS_KIND = "REFERENCE_DOCUMENT";
const MAX_CHUNK_CHARACTERS = 2_000;
const MAX_RETRIEVER_CANDIDATES = 20;
export const RRF_K = 60;

type RetrievalRow = Readonly<{
  tenant_id: string;
  object_id: string;
  source_id: string;
  source_revision: string;
  source_hash: string;
  deck_version: string;
  manifest_hash: string;
  title: string;
  anchor: string;
  content: string;
  embedding: number[];
  authorization_version: string;
  /** Absent on rows persisted before reference documents existed; those are deck slides. */
  readonly corpus_kind?: string;
}>;

type RetrievalRowWithoutEmbedding = Omit<RetrievalRow, "embedding">;
type LexicalRetrievalRow = RetrievalRow & Readonly<{ lexical_score: number }>;

export type HybridRetrievalDiagnostic = Readonly<{
  retriever: "LEXICAL" | "DENSE";
  failure: "FTS_EXECUTION_FAILED" | "EMBEDDING_FAILED";
  errorType: string;
}>;

export interface HybridRetrievalDiagnosticObserver {
  observe(diagnostic: HybridRetrievalDiagnostic): void;
}

export interface DeckEmbeddingPort {
  embed(text: string, principal: RetrievalPrincipal): Promise<readonly number[]>;
}

export interface DeckAccessAuthority {
  authorize(principal: RetrievalPrincipal, request: RetrievalRequest): Promise<boolean>;
}

export type DeckIndexLogEvent = Readonly<{
  outcome: "INDEXED" | "SKIPPED" | "FAILED";
  reason:
    | "COMPLETED"
    | "ACCESS_DENIED"
    | "ACCESS_CHECK_FAILED"
    | "ARTIFACT_ROOT_UNREADABLE"
    | "NO_MATCHING_MANIFEST"
    | "NO_EXTRACTABLE_TEXT"
    | "ALREADY_INDEXED"
    | "PREPARATION_FAILED";
  durationMs: number;
  indexedChunkCount: number;
  matchingArtifactCount: number;
  skippedArtifactCount: number;
  skippedSlideCount: number;
  errorType?: string;
  /**
   * The failure's own message. Without it a broken indexing run is indistinguishable from any
   * other `Error`, which is exactly what hid a schema mismatch behind twenty identical
   * `FAILED:PREPARATION_FAILED` lines.
   */
  errorMessage?: string;
}>;

export interface DeckIndexLogger {
  log(event: DeckIndexLogEvent): void;
}

export class PostgresDeckRetrievalStore
  implements
    RetrievalCorpusPreparer,
    RetrievalAuthorizationPolicy,
    AuthorizedAnnIndex,
    PrivateRetrievalObjectStore
{
  readonly #repository: TenantScopedPostgresRepository;
  readonly #artifactRoot: string;
  readonly #embedding: DeckEmbeddingPort;
  readonly #access: DeckAccessAuthority;
  readonly #logger: DeckIndexLogger | undefined;
  readonly #retrievalDiagnostics: HybridRetrievalDiagnosticObserver | undefined;

  constructor(options: {
    readonly sql?: Sql;
    readonly repository?: TenantScopedPostgresRepository;
    readonly artifactRoot: string;
    readonly embedding: DeckEmbeddingPort;
    readonly access: DeckAccessAuthority;
    readonly logger?: DeckIndexLogger;
    readonly retrievalDiagnostics?: HybridRetrievalDiagnosticObserver;
  }) {
    if (options.repository !== undefined) {
      this.#repository = options.repository;
    } else {
      const sql = options.sql;
      if (sql === undefined) throw new Error("A PostgreSQL deck retrieval repository is required");
      this.#repository = {
        transaction: (_tenantId, operation) => operation(sql),
      };
    }
    this.#artifactRoot = options.artifactRoot;
    this.#embedding = options.embedding;
    this.#access = options.access;
    this.#logger = options.logger;
    this.#retrievalDiagnostics = options.retrievalDiagnostics;
  }

  async prepare(principal: RetrievalPrincipal, request: RetrievalRequest): Promise<void> {
    const startedAtMs = Date.now();
    let matchingArtifactCount = 0;
    let skippedArtifactCount = 0;
    let skippedSlideCount = 0;
    let extractableChunkCount = 0;
    let indexedChunkCount = 0;
    const log = (
      outcome: DeckIndexLogEvent["outcome"],
      reason: DeckIndexLogEvent["reason"],
      error?: unknown,
    ) => {
      const errorType =
        error === undefined ? undefined : error instanceof Error ? error.name : "UnknownError";
      const errorMessage =
        error === undefined ? undefined : error instanceof Error ? error.message : String(error);
      this.#logger?.log({
        outcome,
        reason,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        indexedChunkCount,
        matchingArtifactCount,
        skippedArtifactCount,
        skippedSlideCount,
        ...(errorType === undefined ? {} : { errorType }),
        ...(errorMessage === undefined ? {} : { errorMessage }),
      });
    };

    let authorized: boolean;
    try {
      authorized = await this.#access.authorize(principal, request);
    } catch (error) {
      log("FAILED", "ACCESS_CHECK_FAILED", error);
      throw error;
    }
    if (!authorized) {
      log("SKIPPED", "ACCESS_DENIED");
      return;
    }

    let artifactIds: readonly string[];
    try {
      artifactIds = await readdir(this.#artifactRoot);
    } catch (error) {
      log(
        "FAILED",
        "ARTIFACT_ROOT_UNREADABLE",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw error;
    }

    const pendingRows = new Map<string, RetrievalRowWithoutEmbedding>();
    try {
      for (const artifactId of artifactIds) {
        if (artifactId.endsWith(".part")) {
          skippedArtifactCount += 1;
          continue;
        }
        const artifactDir = join(this.#artifactRoot, artifactId);
        let renderManifest: ReturnType<typeof RenderJsonSchema.parse>;
        let ingestion: IngestionJson;
        try {
          renderManifest = RenderJsonSchema.parse(
            JSON.parse(await readFile(join(artifactDir, "render.json"), "utf8")),
          );
          ingestion = IngestionJsonSchema.parse(
            JSON.parse(await readFile(join(artifactDir, "ingestion.json"), "utf8")),
          );
        } catch {
          skippedArtifactCount += 1;
          continue;
        }
        const orderedRenderSlides = [...renderManifest.slides].sort(
          (left, right) => left.source_index - right.source_index,
        );
        const orderedStructuralSlides = [...ingestion.manifest.slides].sort(
          (left, right) => left.source_index - right.source_index,
        );
        const sourceDeckHash = renderManifest.deck_id.replace(/^deck_/, "");
        const deckVersion = `deck_${sourceDeckHash}`;
        const manifestHash = createHash("sha256")
          .update(
            `render-manifest:${renderManifest.deck_id}:${orderedRenderSlides.map((slide) => slide.content_sha256).join(":")}`,
            "utf8",
          )
          .digest("hex");
        if (
          deckVersion !== request.deckVersion ||
          manifestHash !== request.manifestHash ||
          renderManifest.deck_id !== ingestion.manifest.deck_id ||
          renderManifest.deck_id !== `deck_${ingestion.manifest.source_sha256}` ||
          orderedRenderSlides.length !== orderedStructuralSlides.length ||
          orderedRenderSlides.some(
            (slide, offset) => slide.source_index !== orderedStructuralSlides[offset]?.source_index,
          )
        ) {
          skippedArtifactCount += 1;
          continue;
        }
        matchingArtifactCount += 1;

        for (const slide of orderedStructuralSlides) {
          const chunks = chunkText(extractStructuralText(slide.elements));
          if (chunks.length === 0) skippedSlideCount += 1;
          extractableChunkCount += chunks.length;
          for (const [offset, content] of chunks.entries()) {
            const sourceHash = createHash("sha256").update(content, "utf8").digest("hex");
            const objectId = createHash("sha256")
              .update(
                `${principal.tenantId}:${deckVersion}:${slide.slide_key}:${offset}:${sourceHash}`,
              )
              .digest("hex");
            pendingRows.set(objectId, {
              tenant_id: principal.tenantId,
              object_id: objectId,
              source_id: slide.source_id,
              source_revision: ingestion.manifest.source_sha256,
              source_hash: sourceHash,
              deck_version: deckVersion,
              manifest_hash: manifestHash,
              title: `Slide ${slide.source_index}`,
              anchor: `slide=${slide.source_index}&chunk=${offset + 1}`,
              content,
              authorization_version: AUTHORIZATION_VERSION,
            });
          }
        }
      }

      if (matchingArtifactCount === 0) {
        log("SKIPPED", "NO_MATCHING_MANIFEST");
        return;
      }

      // Reference-document chunks share this table but are owned by the upload flow; deck
      // preparation must reconcile and replace only its own slide-derived rows.
      const existingRows = await this.#repository.transaction(
        principal.tenantId,
        async (sql) =>
          sql<readonly Pick<RetrievalRow, "object_id" | "source_revision" | "source_hash">[]>`
          SELECT object_id, source_revision, source_hash
          FROM private_app.deck_retrieval_chunks
          WHERE tenant_id = ${principal.tenantId}
            AND deck_version = ${request.deckVersion}
            AND manifest_hash = ${request.manifestHash}
            AND authorization_version = ${AUTHORIZATION_VERSION}
            AND corpus_kind = ${DECK_CORPUS_KIND}
        `,
      );
      const unchanged =
        existingRows.length === pendingRows.size &&
        existingRows.every((existing) => {
          const pending = pendingRows.get(existing.object_id);
          return (
            pending?.source_revision === existing.source_revision &&
            pending.source_hash === existing.source_hash
          );
        });
      if (unchanged) {
        log("SKIPPED", extractableChunkCount === 0 ? "NO_EXTRACTABLE_TEXT" : "ALREADY_INDEXED");
        return;
      }

      const rows: RetrievalRow[] = [];
      for (const pending of pendingRows.values()) {
        const embedding = [...(await this.#embedding.embed(pending.content, principal))];
        if (embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) {
          throw new Error("Deck embedding provider returned an invalid vector");
        }
        rows.push({ ...pending, embedding });
      }

      // Every slide of a freshly uploaded deck asks for a recommendation at once, so this
      // preparation runs concurrently for the same scope. Without a lock each racer saw an
      // empty table and they collided on the primary key, failing the first upload for
      // everyone but the winner. The lock is transaction-scoped, so it releases on commit.
      const written = await this.#repository.transaction(principal.tenantId, async (sql) => {
        await sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`${principal.tenantId}:${request.deckVersion}:${request.manifestHash}:${DECK_CORPUS_KIND}`},
              0
            )
          )
        `;
        const current = await sql<readonly Pick<RetrievalRow, "object_id">[]>`
          SELECT object_id
          FROM private_app.deck_retrieval_chunks
          WHERE tenant_id = ${principal.tenantId}
            AND deck_version = ${request.deckVersion}
            AND manifest_hash = ${request.manifestHash}
            AND authorization_version = ${AUTHORIZATION_VERSION}
            AND corpus_kind = ${DECK_CORPUS_KIND}
        `;
        // A racer that already wrote this exact scope while we were embedding wins; repeating
        // its work would only rewrite identical rows.
        if (existingRows.length === 0 && current.length > 0) return false;
        if (current.length > 0) {
          await sql`
            DELETE FROM private_app.deck_retrieval_chunks
            WHERE tenant_id = ${principal.tenantId}
              AND deck_version = ${request.deckVersion}
              AND corpus_kind = ${DECK_CORPUS_KIND}
          `;
        }
        for (const row of rows) {
          await insertChunkRow(sql, { ...row, corpus_kind: DECK_CORPUS_KIND });
        }
        return true;
      });
      if (!written) {
        log("SKIPPED", "ALREADY_INDEXED");
        return;
      }
      indexedChunkCount = rows.length;
    } catch (error) {
      log("FAILED", "PREPARATION_FAILED", error);
      throw error;
    }

    if (extractableChunkCount === 0) log("SKIPPED", "NO_EXTRACTABLE_TEXT");
    else log("INDEXED", "COMPLETED");
  }

  async prefilter(principal: RetrievalPrincipal, request: RetrievalRequest) {
    if (!(await this.#access.authorize(principal, request))) {
      return {
        version: AUTHORIZATION_VERSION,
        current: true,
        authorizedObjectIds: [],
        sourceRevisions: {},
      };
    }
    const rows = await this.#repository.transaction(
      principal.tenantId,
      async (sql) =>
        sql<readonly { object_id: string; source_revision: string; corpus_kind?: string }[]>`
        SELECT object_id, source_revision, corpus_kind
        FROM private_app.deck_retrieval_chunks
        WHERE tenant_id = ${principal.tenantId}
          AND deck_version = ${request.deckVersion}
          AND manifest_hash = ${request.manifestHash}
          AND authorization_version = ${AUTHORIZATION_VERSION}
      `,
    );
    const sourceRevisions = Object.fromEntries(
      rows.map((row) => [row.object_id, row.source_revision] as const),
    );
    // Only deck slides carry a deck-derived source revision; uploaded reference documents are
    // current whenever their rows exist for this scope.
    const revisionsAreCurrent = rows
      .filter((row) => row.corpus_kind !== REFERENCE_DOCUMENT_CORPUS_KIND)
      .every((row) => request.deckVersion === `deck_${row.source_revision}`);
    return {
      version: AUTHORIZATION_VERSION,
      current: revisionsAreCurrent,
      authorizedObjectIds: revisionsAreCurrent ? rows.map((row) => row.object_id) : [],
      sourceRevisions: revisionsAreCurrent ? sourceRevisions : {},
    };
  }

  async authorizeObject(
    principal: RetrievalPrincipal,
    object: RetrievalObjectMetadata,
    version: string,
  ): Promise<boolean> {
    return principal.tenantId === object.tenantId && version === AUTHORIZATION_VERSION;
  }

  async isCurrent(_tenantId: string, version: string): Promise<boolean> {
    return version === AUTHORIZATION_VERSION;
  }

  async search(input: {
    readonly tenantId: string;
    readonly query: string;
    readonly queryVector: readonly number[];
    readonly authorizedObjectIds: readonly string[];
    readonly limit: number;
  }): Promise<readonly AnnCandidate[]> {
    if (input.authorizedObjectIds.length === 0) return [];
    const authorizedIds = [...new Set(input.authorizedObjectIds)].sort();

    // This common RLS read must succeed before either retriever is allowed to contribute.
    const rows = await this.#repository.transaction(
      input.tenantId,
      async (sql) =>
        sql<readonly RetrievalRow[]>`
        SELECT *
        FROM private_app.deck_retrieval_chunks
        WHERE tenant_id = ${input.tenantId}
          AND object_id IN ${sql(authorizedIds)}
      `,
    );
    if (
      rows.length !== authorizedIds.length ||
      rows.some((row) => row.tenant_id !== input.tenantId || !authorizedIds.includes(row.object_id))
    ) {
      throw new Error("Authorized retrieval revision set changed before candidate generation");
    }

    let lexicalRows: readonly LexicalRetrievalRow[] = [];
    try {
      lexicalRows = await this.#repository.transaction(
        input.tenantId,
        async (sql) =>
          sql<readonly LexicalRetrievalRow[]>`
          WITH lexical AS (
            SELECT *,
              ts_rank_cd(search_vector, plainto_tsquery('simple', ${input.query})) AS lexical_score
            FROM private_app.deck_retrieval_chunks
            WHERE tenant_id = ${input.tenantId}
              AND object_id IN ${sql(authorizedIds)}
          )
          SELECT * FROM lexical
          WHERE lexical_score > 0
          ORDER BY lexical_score DESC, object_id ASC
          LIMIT ${MAX_RETRIEVER_CANDIDATES}
        `,
      );
    } catch (error) {
      this.#retrievalDiagnostics?.observe({
        retriever: "LEXICAL",
        failure: "FTS_EXECUTION_FAILED",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }

    const lexical = [...lexicalRows]
      .filter((row) => authorizedIds.includes(row.object_id))
      .sort(
        (left, right) =>
          right.lexical_score - left.lexical_score || left.object_id.localeCompare(right.object_id),
      )
      .slice(0, MAX_RETRIEVER_CANDIDATES);

    let dense: readonly RetrievalRow[] = [];
    if (
      input.queryVector.length === 0 ||
      input.queryVector.some((value) => !Number.isFinite(value))
    ) {
      this.#retrievalDiagnostics?.observe({
        retriever: "DENSE",
        failure: "EMBEDDING_FAILED",
        errorType: "InvalidQueryEmbedding",
      });
    } else {
      dense = rows
        .flatMap((row) => {
          const score = cosineSimilarity(input.queryVector, row.embedding);
          return score === null ? [] : [{ row, score }];
        })
        .sort(
          (left, right) =>
            right.score - left.score || left.row.object_id.localeCompare(right.row.object_id),
        )
        .slice(0, MAX_RETRIEVER_CANDIDATES)
        .map(({ row }) => row);
    }

    return reciprocalRankFusion(lexical, dense).slice(0, input.limit);
  }

  async readMetadata(tenantId: string, objectId: string): Promise<RetrievalObjectMetadata | null> {
    const row = await this.#read(tenantId, objectId);
    return row === undefined
      ? null
      : {
          tenantId: row.tenant_id,
          objectId: row.object_id,
          sourceId: row.source_id,
          sourceRevision: row.source_revision,
          sourceHash: row.source_hash,
          deckVersion: row.deck_version,
          manifestHash: row.manifest_hash,
          title: row.title,
          anchor: row.anchor,
          rights: "APPROVED",
          containsPii: false,
        };
  }

  async readContent(tenantId: string, objectId: string): Promise<string | null> {
    return (await this.#read(tenantId, objectId))?.content ?? null;
  }

  async #read(tenantId: string, objectId: string): Promise<RetrievalRow | undefined> {
    const rows = await this.#repository.transaction(
      tenantId,
      async (sql) =>
        sql<readonly RetrievalRow[]>`
        SELECT * FROM private_app.deck_retrieval_chunks
        WHERE tenant_id = ${tenantId} AND object_id = ${objectId}
        LIMIT 1
      `,
    );
    return rows[0];
  }
}

export type StructuralElement = IngestionJson["manifest"]["slides"][number]["elements"][number];

export function extractStructuralText(elements: readonly StructuralElement[]): string {
  const values = elements.flatMap((element) => {
    if (element.kind === "text") return [element.text];
    if (element.kind === "table") return element.rows.map((row) => row.join(" "));
    if (element.kind === "chart") {
      return [
        element.chart_type,
        ...element.categories,
        ...element.series.flatMap((series) => [series.name, ...series.values]),
      ];
    }
    return [];
  });
  return values
    .join("\n")
    .replace(/<(?:date\/time|footer|number)>/gi, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

type ChunkInsertRow = RetrievalRow & Readonly<{ corpus_kind?: string }>;

export async function insertChunkRow(sql: Sql, row: ChunkInsertRow): Promise<void> {
  await sql`
    INSERT INTO private_app.deck_retrieval_chunks (
      tenant_id, object_id, source_id, source_revision, source_hash,
      deck_version, manifest_hash, title, anchor, content, embedding,
      authorization_version, corpus_kind
    ) VALUES (
      ${row.tenant_id}, ${row.object_id}, ${row.source_id}, ${row.source_revision},
      ${row.source_hash}, ${row.deck_version}, ${row.manifest_hash}, ${row.title},
      ${row.anchor}, ${row.content}, ${sql.array(row.embedding)}::double precision[],
      ${row.authorization_version}, ${row.corpus_kind ?? DECK_CORPUS_KIND}
    )
  `;
}

export function chunkText(text: string): readonly string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += MAX_CHUNK_CHARACTERS) {
    const chunk = text.slice(start, start + MAX_CHUNK_CHARACTERS).trim();
    if (chunk.length > 0) chunks.push(chunk);
  }
  return chunks;
}

function reciprocalRankFusion(
  lexical: readonly RetrievalRow[],
  dense: readonly RetrievalRow[],
): readonly AnnCandidate[] {
  const fused = new Map<
    string,
    { row: RetrievalRow; score: number; seenRetrievers: Set<"LEXICAL" | "DENSE"> }
  >();
  const addRanked = (rows: readonly RetrievalRow[], retriever: "LEXICAL" | "DENSE") => {
    const seenKeys = new Set<string>();
    for (const [offset, row] of rows.entries()) {
      const key = retrievalDedupeKey(row);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const existing = fused.get(key);
      if (existing === undefined) {
        fused.set(key, {
          row,
          score: 1 / (RRF_K + offset + 1),
          seenRetrievers: new Set([retriever]),
        });
      } else if (!existing.seenRetrievers.has(retriever)) {
        existing.score += 1 / (RRF_K + offset + 1);
        existing.seenRetrievers.add(retriever);
        if (row.object_id.localeCompare(existing.row.object_id) < 0) existing.row = row;
      }
    }
  };
  addRanked(lexical, "LEXICAL");
  addRanked(dense, "DENSE");

  return [...fused.values()]
    .map(({ row, score }) => ({
      tenantId: row.tenant_id,
      objectId: row.object_id,
      score,
      indexedSourceRevision: row.source_revision,
      indexedSourceHash: row.source_hash,
      indexedDeckVersion: row.deck_version,
      indexedManifestHash: row.manifest_hash,
      indexedAuthorizationVersion: row.authorization_version,
    }))
    .sort((left, right) => right.score - left.score || left.objectId.localeCompare(right.objectId));
}

function retrievalDedupeKey(row: RetrievalRow): string {
  const chunkIndex = new URLSearchParams(row.anchor).get("chunk") ?? row.anchor;
  // source_id is the manifest's stable identity for the slide represented by slide_key.
  return [row.tenant_id, row.deck_version, row.source_revision, row.source_id, chunkIndex].join(
    "\0",
  );
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number | null {
  if (left.length === 0 || left.length !== right.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

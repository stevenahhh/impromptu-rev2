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
const MAX_CHUNK_CHARACTERS = 2_000;

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
}>;

type RetrievalRowWithoutEmbedding = Omit<RetrievalRow, "embedding">;

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

  constructor(options: {
    readonly sql?: Sql;
    readonly repository?: TenantScopedPostgresRepository;
    readonly artifactRoot: string;
    readonly embedding: DeckEmbeddingPort;
    readonly access: DeckAccessAuthority;
    readonly logger?: DeckIndexLogger;
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
      errorType?: string,
    ) => {
      this.#logger?.log({
        outcome,
        reason,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        indexedChunkCount,
        matchingArtifactCount,
        skippedArtifactCount,
        skippedSlideCount,
        ...(errorType === undefined ? {} : { errorType }),
      });
    };

    let authorized: boolean;
    try {
      authorized = await this.#access.authorize(principal, request);
    } catch (error) {
      log("FAILED", "ACCESS_CHECK_FAILED", error instanceof Error ? error.name : "UnknownError");
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

      await this.#repository.transaction(principal.tenantId, async (sql) => {
        if (existingRows.length > 0) {
          await sql`
            DELETE FROM private_app.deck_retrieval_chunks
            WHERE tenant_id = ${principal.tenantId}
              AND deck_version = ${request.deckVersion}
          `;
        }
        for (const row of rows) {
          await sql`
            INSERT INTO private_app.deck_retrieval_chunks (
              tenant_id, object_id, source_id, source_revision, source_hash,
              deck_version, manifest_hash, title, anchor, content, embedding,
              authorization_version
            ) VALUES (
              ${row.tenant_id}, ${row.object_id}, ${row.source_id}, ${row.source_revision},
              ${row.source_hash}, ${row.deck_version}, ${row.manifest_hash}, ${row.title},
              ${row.anchor}, ${row.content}, ${sql.array(row.embedding)}::double precision[],
              ${row.authorization_version}
            )
          `;
        }
      });
      indexedChunkCount = rows.length;
    } catch (error) {
      log("FAILED", "PREPARATION_FAILED", error instanceof Error ? error.name : "UnknownError");
      throw error;
    }

    if (extractableChunkCount === 0) log("SKIPPED", "NO_EXTRACTABLE_TEXT");
    else log("INDEXED", "COMPLETED");
  }

  async prefilter(principal: RetrievalPrincipal, request: RetrievalRequest) {
    if (!(await this.#access.authorize(principal, request))) {
      return { version: AUTHORIZATION_VERSION, current: true, authorizedObjectIds: [] };
    }
    const rows = await this.#repository.transaction(
      principal.tenantId,
      async (sql) =>
        sql<readonly { object_id: string }[]>`
        SELECT object_id
        FROM private_app.deck_retrieval_chunks
        WHERE tenant_id = ${principal.tenantId}
          AND deck_version = ${request.deckVersion}
          AND manifest_hash = ${request.manifestHash}
          AND authorization_version = ${AUTHORIZATION_VERSION}
      `,
    );
    return {
      version: AUTHORIZATION_VERSION,
      current: true,
      authorizedObjectIds: rows.map((row) => row.object_id),
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
    if (input.authorizedObjectIds.length === 0 || input.queryVector.length === 0) return [];
    const rows = await this.#repository.transaction(
      input.tenantId,
      async (sql) =>
        sql<readonly RetrievalRow[]>`
        SELECT *
        FROM private_app.deck_retrieval_chunks
        WHERE tenant_id = ${input.tenantId}
          AND object_id IN ${sql(input.authorizedObjectIds)}
      `,
    );
    return rows
      .flatMap((row) => {
        const score = cosineSimilarity(input.queryVector, row.embedding);
        return score === null
          ? []
          : [
              {
                tenantId: row.tenant_id,
                objectId: row.object_id,
                score,
                indexedSourceHash: row.source_hash,
                indexedDeckVersion: row.deck_version,
                indexedManifestHash: row.manifest_hash,
                indexedAuthorizationVersion: row.authorization_version,
              },
            ];
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit);
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

type StructuralElement = IngestionJson["manifest"]["slides"][number]["elements"][number];

function extractStructuralText(elements: readonly StructuralElement[]): string {
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

function chunkText(text: string): readonly string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += MAX_CHUNK_CHARACTERS) {
    const chunk = text.slice(start, start + MAX_CHUNK_CHARACTERS).trim();
    if (chunk.length > 0) chunks.push(chunk);
  }
  return chunks;
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

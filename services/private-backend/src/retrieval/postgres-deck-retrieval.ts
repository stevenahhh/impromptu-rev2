import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RetrievalRequest } from "@impromptu/contracts/retrieval";
import type { Sql } from "postgres";
import { RenderJsonSchema } from "../deck-render-subprocess.ts";
import type {
  AnnCandidate,
  AuthorizedAnnIndex,
  PrivateRetrievalObjectStore,
  RetrievalAuthorizationPolicy,
  RetrievalCorpusPreparer,
  RetrievalObjectMetadata,
  RetrievalPrincipal,
} from "./internal-retrieval.ts";

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
  readonly #sql: Sql;
  readonly #artifactRoot: string;
  readonly #embedding: DeckEmbeddingPort;
  readonly #access: DeckAccessAuthority;
  readonly #logger: DeckIndexLogger | undefined;

  constructor(options: {
    readonly sql: Sql;
    readonly artifactRoot: string;
    readonly embedding: DeckEmbeddingPort;
    readonly access: DeckAccessAuthority;
    readonly logger?: DeckIndexLogger;
  }) {
    this.#sql = options.sql;
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

    try {
      for (const artifactId of artifactIds) {
        if (artifactId.endsWith(".part")) {
          skippedArtifactCount += 1;
          continue;
        }
        const artifactDir = join(this.#artifactRoot, artifactId);
        let manifest: ReturnType<typeof RenderJsonSchema.parse>;
        try {
          manifest = RenderJsonSchema.parse(
            JSON.parse(await readFile(join(artifactDir, "render.json"), "utf8")),
          );
        } catch {
          skippedArtifactCount += 1;
          continue;
        }
        const ordered = [...manifest.slides].sort(
          (left, right) => left.source_index - right.source_index,
        );
        const sourceDeckHash = manifest.deck_id.replace(/^deck_/, "");
        const deckVersion = `deck_${sourceDeckHash}`;
        const manifestHash = createHash("sha256")
          .update(
            `render-manifest:${manifest.deck_id}:${ordered.map((slide) => slide.content_sha256).join(":")}`,
            "utf8",
          )
          .digest("hex");
        if (deckVersion !== request.deckVersion || manifestHash !== request.manifestHash) {
          skippedArtifactCount += 1;
          continue;
        }
        matchingArtifactCount += 1;

        for (const slide of ordered) {
          if (!slide.relative_path.toLowerCase().endsWith(".svg")) {
            skippedSlideCount += 1;
            continue;
          }
          let document: string;
          try {
            document = await readFile(join(artifactDir, slide.relative_path), "utf8");
          } catch {
            skippedSlideCount += 1;
            continue;
          }
          const chunks = chunkText(extractSvgText(document));
          if (chunks.length === 0) skippedSlideCount += 1;
          extractableChunkCount += chunks.length;
          for (const [offset, content] of chunks.entries()) {
            const sourceHash = createHash("sha256").update(content, "utf8").digest("hex");
            const objectId = createHash("sha256")
              .update(
                `${principal.tenantId}:${deckVersion}:${slide.slide_key}:${offset}:${sourceHash}`,
              )
              .digest("hex");
            const existing = await this.#sql<readonly { object_id: string }[]>`
              SELECT object_id
              FROM private_app.deck_retrieval_chunks
              WHERE tenant_id = ${principal.tenantId} AND object_id = ${objectId}
            `;
            if (existing.length > 0) continue;
            const vector = [...(await this.#embedding.embed(content, principal))];
            if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
              throw new Error("Deck embedding provider returned an invalid vector");
            }
            await this.#sql`
              INSERT INTO private_app.deck_retrieval_chunks (
                tenant_id, object_id, source_id, source_revision, source_hash,
                deck_version, manifest_hash, title, anchor, content, embedding,
                authorization_version
              ) VALUES (
                ${principal.tenantId}, ${objectId}, ${slide.slide_key}, ${sourceHash}, ${sourceHash},
                ${deckVersion}, ${manifestHash}, ${`Slide ${slide.source_index}`},
                ${`slide=${slide.source_index}&chunk=${offset + 1}`}, ${content},
                ${this.#sql.array(vector)}::double precision[], ${AUTHORIZATION_VERSION}
              )
              ON CONFLICT (tenant_id, object_id) DO NOTHING
            `;
            indexedChunkCount += 1;
          }
        }
      }
    } catch (error) {
      log("FAILED", "PREPARATION_FAILED", error instanceof Error ? error.name : "UnknownError");
      throw error;
    }

    if (matchingArtifactCount === 0) log("SKIPPED", "NO_MATCHING_MANIFEST");
    else if (extractableChunkCount === 0) log("SKIPPED", "NO_EXTRACTABLE_TEXT");
    else if (indexedChunkCount === 0) log("SKIPPED", "ALREADY_INDEXED");
    else log("INDEXED", "COMPLETED");
  }

  async prefilter(principal: RetrievalPrincipal, request: RetrievalRequest) {
    if (!(await this.#access.authorize(principal, request))) {
      return { version: AUTHORIZATION_VERSION, current: true, authorizedObjectIds: [] };
    }
    const rows = await this.#sql<readonly { object_id: string }[]>`
      SELECT object_id
      FROM private_app.deck_retrieval_chunks
      WHERE tenant_id = ${principal.tenantId}
        AND deck_version = ${request.deckVersion}
        AND manifest_hash = ${request.manifestHash}
        AND authorization_version = ${AUTHORIZATION_VERSION}
    `;
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
    const rows = await this.#sql<readonly RetrievalRow[]>`
      SELECT *
      FROM private_app.deck_retrieval_chunks
      WHERE tenant_id = ${input.tenantId}
        AND object_id IN ${this.#sql(input.authorizedObjectIds)}
    `;
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
    const rows = await this.#sql<readonly RetrievalRow[]>`
      SELECT * FROM private_app.deck_retrieval_chunks
      WHERE tenant_id = ${tenantId} AND object_id = ${objectId}
      LIMIT 1
    `;
    return rows[0];
  }
}

function extractSvgText(document: string): string {
  return document
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
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

import type { RetrievalRequest } from "@impromptu/contracts/retrieval";
import type { Sql } from "postgres";
import { prepareDeckCorpus } from "./deck-corpus-preparation.ts";
import { searchAuthorizedCandidates } from "./deck-hybrid-search.ts";
import {
  AUTHORIZATION_VERSION,
  DECK_CORPUS_KIND,
  type DeckAccessAuthority,
  type DeckEmbeddingPort,
  type DeckIndexLogger,
  type HybridRetrievalDiagnosticObserver,
  MAX_CHUNK_CHARACTERS,
  REFERENCE_DOCUMENT_CORPUS_KIND,
  type RetrievalRow,
} from "./deck-retrieval-model.ts";
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
    await prepareDeckCorpus(
      {
        repository: this.#repository,
        artifactRoot: this.#artifactRoot,
        embedding: this.#embedding,
        access: this.#access,
        logger: this.#logger,
      },
      principal,
      request,
    );
  }

  /**
   * The text this deck actually carries on one slide, joined in chunk order. A browser can only
   * name a slide by its ordinal and its accessible name, and asking for evidence with that name
   * made the model assert the ordinal as a fact the deck never states. Grounding the request in
   * the slide's own words is what the presenter is asking for in the first place. Returns null
   * when the slide carries no extractable text, so the caller keeps its own query.
   */
  async readSlideText(
    principal: RetrievalPrincipal,
    request: Readonly<{ deckVersion: string; manifestHash: string; slideOrdinal: number }>,
  ): Promise<string | null> {
    const rows = await this.#repository.transaction(
      principal.tenantId,
      async (sql) =>
        await sql<readonly { content: string; anchor: string }[]>`
          SELECT content, anchor
          FROM private_app.deck_retrieval_chunks
          WHERE tenant_id = ${principal.tenantId}
            AND deck_version = ${request.deckVersion}
            AND manifest_hash = ${request.manifestHash}
            AND corpus_kind = ${DECK_CORPUS_KIND}
            AND anchor LIKE ${`slide=${request.slideOrdinal}&%`}
          ORDER BY anchor
        `,
    );
    const text = rows
      .map((row) => row.content)
      .join(" ")
      .trim();
    return text.length === 0 ? null : text.slice(0, MAX_CHUNK_CHARACTERS);
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
    return searchAuthorizedCandidates(
      { repository: this.#repository, retrievalDiagnostics: this.#retrievalDiagnostics },
      input,
    );
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

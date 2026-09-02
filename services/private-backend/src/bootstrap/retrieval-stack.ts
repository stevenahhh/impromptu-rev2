import type { ServerModelRouter } from "@impromptu/model-router";
import { createTrustedModelContext } from "@impromptu/model-router";
import type { Sql } from "postgres";
import { z } from "zod";
import type { JsonLogger } from "../observability.ts";
import type { PreparedEvidenceCoordinator, PreparedEvidenceStore } from "../prepared-evidence.ts";
import {
  createIngestionBackedReferenceTextExtractor,
  PostgresReferenceDocumentLibrary,
} from "../reference-documents.ts";
import {
  NodePinnedHttpsTransport,
  NodePublicDnsResolver,
  SafeExternalEvidenceFetcher,
} from "../retrieval/external-fetch.ts";
import {
  externalSearchCredentialsFromEnvironment,
  KeylessFirstExternalSearchBoundary,
} from "../retrieval/external-search.ts";
import type { RetrievalPrincipal } from "../retrieval/internal-retrieval.ts";
import { InternalRetrievalService } from "../retrieval/internal-retrieval.ts";
import { PostgresDeckRetrievalStore } from "../retrieval/postgres-deck-retrieval.ts";
import { createTenantScopedPostgresRepository } from "../retrieval/tenant-scoped-postgres-repository.ts";

export interface RetrievalStack {
  readonly referenceDocuments: PostgresReferenceDocumentLibrary;
  readonly retrievalStore: PostgresDeckRetrievalStore;
  readonly internalRetrieval: InternalRetrievalService;
  readonly externalFetcher: SafeExternalEvidenceFetcher;
  readonly externalSearch: KeylessFirstExternalSearchBoundary;
}

/** Wires the retrieval subsystem: deck/reference embeddings, access policy, external evidence. */
export function createRetrievalStack(options: {
  readonly privateSql: Sql;
  readonly store: PreparedEvidenceStore;
  readonly deckArtifactRoot: string;
  readonly ingestionProject: string;
  readonly logger: JsonLogger;
  readonly modelRouter: ServerModelRouter;
  /** Lazy accessor: the coordinator is composed after the recommendation pipeline it feeds. */
  readonly readCoordinator: () => PreparedEvidenceCoordinator;
}): RetrievalStack {
  const { privateSql, store, deckArtifactRoot, ingestionProject, logger, modelRouter } = options;
  const retrievalRepository = createTenantScopedPostgresRepository(privateSql);
  const deckEmbedding = {
    async embed(text: string, principal: RetrievalPrincipal): Promise<readonly number[]> {
      const startedAtMs = Date.now();
      const signal = AbortSignal.timeout(15_000);
      const result = await modelRouter.invoke(
        { capability: "embedding", input: { task: "EMBED_RETRIEVAL_QUERY", query: text } },
        createTrustedModelContext({
          tenantId: principal.tenantId,
          principalId: principal.principalId,
          policyVersion: "model-policy-v1",
          requestId: `deck-index:${crypto.randomUUID()}`,
          traceId: `deck-index:${principal.tenantId}:${startedAtMs}`,
          deadlineAtMs: startedAtMs + 15_000,
          signal,
        }),
      );
      if (!result.ok) throw new Error(`Deck embedding failed: ${result.error.code}`);
      return z
        .object({ vector: z.array(z.number().finite()).min(1).max(8_192) })
        .strict()
        .parse(result.output).vector;
    },
  };
  // Presenter-uploaded reference documents are extracted (reusing services/ingestion for
  // PDF/PPTX), chunked and embedded with the same port as deck slides so both corpora share
  // one vector space and one retrieval table.
  const referenceDocuments = new PostgresReferenceDocumentLibrary({
    repository: retrievalRepository,
    extractor: createIngestionBackedReferenceTextExtractor({ ingestionProject }),
    embedding: deckEmbedding,
    presentations: {
      async resolveOwnedPresentation({ accountId, presentationSessionId }) {
        const presentation = store.presentations.get(presentationSessionId);
        if (
          presentation === undefined ||
          String(
            presentation.lifecycle.ownerAccountId ?? presentation.privateDeck.ownerAccountId,
          ) !== accountId
        ) {
          return null;
        }
        return {
          deckVersion: presentation.privateDeck.deckVersion,
          manifestHash: presentation.privateDeck.manifestHash,
        };
      },
    },
  });
  const retrievalStore = new PostgresDeckRetrievalStore({
    repository: retrievalRepository,
    artifactRoot: deckArtifactRoot,
    access: {
      async authorize(principal, request) {
        return [...store.presentations.values()].some(
          (presentation) =>
            String(presentation.privateDeck.ownerAccountId) === principal.tenantId &&
            presentation.privateDeck.deckVersion === request.deckVersion &&
            presentation.privateDeck.manifestHash === request.manifestHash,
        );
      },
    },
    logger: {
      log(event) {
        const requestId = `deck-index:${crypto.randomUUID()}`;
        logger.request({
          requestId,
          method: "INDEX",
          path: "/internal/deck-retrieval",
          status: event.outcome === "FAILED" ? 500 : 200,
          durationMs: event.durationMs,
          outcome: `${event.outcome}:${event.reason}`,
        });
        if (event.errorType !== undefined) {
          logger.error({
            requestId,
            path: "/internal/deck-retrieval",
            errorType: event.errorType,
            ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
          });
        }
      },
    },
    embedding: deckEmbedding,
  });
  const internalRetrieval = new InternalRetrievalService({
    principals: {
      async resolve(accountSessionId) {
        const session = await options
          .readCoordinator()
          .readAccountSession(accountSessionId, Date.now());
        return session.outcome === "APPLIED"
          ? {
              tenantId: session.value.accountId,
              principalId: session.value.actorId,
              groupIds: [],
              attributes: { role: "controller" },
            }
          : null;
      },
    },
    policy: retrievalStore,
    ann: retrievalStore,
    objects: retrievalStore,
    corpus: retrievalStore,
  });
  const externalFetcher = new SafeExternalEvidenceFetcher({
    dns: new NodePublicDnsResolver(),
    transport: new NodePinnedHttpsTransport(),
  });
  const externalSearch = new KeylessFirstExternalSearchBoundary({
    ...externalSearchCredentialsFromEnvironment(Bun.env),
    diagnostics: {
      observe(diagnostic) {
        logger.request({
          requestId: `external-search:${crypto.randomUUID()}`,
          method: "SEARCH",
          path: `/internal/external-search/${diagnostic.provider}`,
          status: 204,
          durationMs: 0,
          outcome: diagnostic.failure,
        });
      },
    },
  });
  return { referenceDocuments, retrievalStore, internalRetrieval, externalFetcher, externalSearch };
}

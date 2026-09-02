import type { RetrievalRequest } from "@impromptu/contracts/retrieval";
import type { RetrievalPrincipal } from "./internal-retrieval.ts";

export const AUTHORIZATION_VERSION = "acl-1";
export const DECK_CORPUS_KIND = "DECK_SLIDE";
export const REFERENCE_DOCUMENT_CORPUS_KIND = "REFERENCE_DOCUMENT";
export const MAX_CHUNK_CHARACTERS = 2_000;

export type RetrievalRow = Readonly<{
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

export type RetrievalRowWithoutEmbedding = Omit<RetrievalRow, "embedding">;
export type LexicalRetrievalRow = RetrievalRow & Readonly<{ lexical_score: number }>;

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

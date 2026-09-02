export { insertChunkRow } from "./deck-chunk-writes.ts";
export { RRF_K } from "./deck-hybrid-ranking.ts";
export type {
  DeckAccessAuthority,
  DeckEmbeddingPort,
  DeckIndexLogEvent,
  DeckIndexLogger,
  HybridRetrievalDiagnostic,
  HybridRetrievalDiagnosticObserver,
} from "./deck-retrieval-model.ts";
export {
  DECK_CORPUS_KIND,
  REFERENCE_DOCUMENT_CORPUS_KIND,
} from "./deck-retrieval-model.ts";
export type { StructuralElement } from "./deck-slide-text.ts";
export { chunkText, extractStructuralText } from "./deck-slide-text.ts";
export { PostgresDeckRetrievalStore } from "./postgres-deck-store.ts";

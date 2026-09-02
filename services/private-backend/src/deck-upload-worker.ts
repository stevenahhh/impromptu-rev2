/**
 * Deck upload worker.
 *
 * Contract: test/deck-upload-worker.test.ts.
 *
 * Consumes the upload strictly as a stream: chunks are written to a staging
 * upload.part as they arrive (hashed and counted in the same pass), so the
 * whole body is never buffered. Filename, extension, empty, and declared-size
 * checks run before the first read; signature validation uses only a bounded
 * prefix. Actual/declaration mismatch and empty bodies reject without invoking
 * the renderer. Deck size itself is not capped: the body never lands in
 * memory, so a large deck costs staging disk and render time, which are
 * bounded elsewhere. After a successful renderer result the output is copied
 * through an artifactRoot-local "<artifactId>.part" directory, each file is
 * fsynced, and the directory is atomically renamed to the immutable
 * artifactRoot/<artifactId>. Symlinks and paths escaping the output tree are
 * rejected.
 */

export type {
  DeckUploadInput,
  DeckUploadOutcome,
  DeckUploadRejectionCode,
  DeckUploadWorker,
  DeckUploadWorkerOptions,
  RenderSubprocessAdapter,
  RenderSubprocessRequest,
  RenderSubprocessResult,
} from "./deck-upload-contract.ts";
export { DeckUploadWorkerError } from "./deck-upload-contract.ts";
export { createDeckUploadWorker } from "./deck-upload-pipeline.ts";

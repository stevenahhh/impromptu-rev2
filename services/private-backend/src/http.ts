// Barrel: the public surface of the private-backend HTTP boundary. Implementation lives in
// ./http/ modules split by responsibility; every symbol re-exported here keeps the original
// import path stable for all existing importers.
export { createPrivateBackendHandler } from "./http/handler.ts";
export type {
  AccountIdentityVerifier,
  DeckUploadAccepted,
  DeckUploadContentType,
  DeckUploadReceipt,
  DeckUploadRejectedResponse,
  DeckUploadService,
  PrivateBackendHandler,
  PrivateBackendHttpDependencies,
  RawDeckUpload,
  RawReferenceDocument,
  ReferenceDocumentService,
  ReferenceDocumentServiceInput,
  ReferenceDocumentSummary,
  ReferenceDocumentUploadResult,
} from "./http/types.ts";

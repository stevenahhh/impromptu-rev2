// Public surface of the private console client. Pure re-exports only — every symbol's
// implementation lives in the responsibility module named below.

export {
  type ConsoleDeckUploadClient,
  type ConsoleSessionClient,
  type ConsoleSessionClientOptions,
  createConsoleSessionClient,
} from "./console-client";
export {
  DECK_UPLOAD_MIME_TYPES,
  DeckUploadError,
  type DeckUploadMimeType,
  type DeckUploadProgress,
  type DeckUploadProgressEvent,
  type DeckUploadView,
  type DeckUploadXhr,
  type UploadDeckOptions,
} from "./deck-upload";
export type { DisplayBindingView, DisplayJoinView, PlaybackCommandView } from "./display-playback";
export { PlaybackCommandRejectedError } from "./display-playback";
export type { LiveCandidateSnapshotView } from "./live-publication";
export type { ActivePresentationView, PresentationSessionView } from "./presentation-lifecycle";
export type { ReportEventSource } from "./private-transport";
export type {
  QaDefenseAnswer,
  QaDefenseCitation,
  QaDefenseLifecycle,
  QaDefenseQuestionRequest,
  SpokenQuestionTranscription,
} from "./qa-defense";
export { QaDefenseNotOpenError } from "./qa-defense";
export type {
  PrivateEvidenceCardView,
  RecommendationOutcome,
  RecommendationRequest,
} from "./recommendations";
export type {
  ReferenceDocumentSummaryView,
  ReferenceDocumentUploadView,
} from "./reference-documents";
export {
  AccountRegistrationError,
  type AccountRegistrationFailure,
  type AccountRegistrationView,
  type AccountSessionView,
} from "./session-auth";
export { SessionReportClientError } from "./session-report-stream";
export type { SessionReportReadView, SessionReportView } from "./session-report-view";

// Assembles the console's private-backend client from the responsibility modules.
// The client object is the only seam App.tsx and the tests consume; each capability
// delegates to one module and adds no behavior of its own.

import { type DeckUploadView, type UploadDeckOptions, uploadDeck } from "./deck-upload";
import {
  approveDisplay,
  type DisplayBindingView,
  type DisplayJoinView,
  type PlaybackCommandView,
  setSlide,
} from "./display-playback";
import {
  approveLiveCandidate,
  type LiveCandidateSnapshotView,
  readLiveCandidates,
} from "./live-publication";
import {
  type ActivePresentationView,
  createPresentation,
  type PresentationSessionView,
} from "./presentation-lifecycle";
import type { PrivateClientContext, ReportEventSource } from "./private-transport";
import {
  openQaDefense,
  type QaDefenseAnswer,
  type QaDefenseLifecycle,
  type QaDefenseQuestionRequest,
  submitQaDefenseQuestion,
} from "./qa-defense";
import {
  type RecommendationOutcome,
  type RecommendationRequest,
  recommend,
} from "./recommendations";
import {
  listReferenceDocuments,
  type ReferenceDocumentSummaryView,
  type ReferenceDocumentUploadView,
  uploadReferenceDocuments,
} from "./reference-documents";
import {
  type AccountRegistrationView,
  type AccountSessionView,
  readSession,
  signIn,
  signOut,
  signUp,
} from "./session-auth";
import { endPresentationAndAwaitReport, readFinalizedReport } from "./session-report-stream";
import type { SessionReportReadView, SessionReportView } from "./session-report-view";

export interface ConsoleSessionClientOptions {
  readonly createReportEventSource?: (url: string) => ReportEventSource;
  readonly reportReadyTimeoutMs?: number;
}

export interface ConsoleSessionClient {
  signUp(username: string, password: string): Promise<AccountRegistrationView>;
  signIn(username: string, password: string): Promise<AccountSessionView>;
  readSession(): Promise<AccountSessionView | null>;
  signOut(csrfToken: string): Promise<void>;
  createPresentation(
    csrfToken: string,
    artifacts: { readonly privateDeck: unknown; readonly publicDeck: unknown },
  ): Promise<PresentationSessionView>;
  recommend(
    csrfToken: string,
    request: RecommendationRequest,
    signal?: AbortSignal,
  ): Promise<RecommendationOutcome>;
  // Optional like the other late-added surfaces on this client, so narrow injected test
  // doubles stay valid without implementing every capability.
  uploadReferenceDocuments?(
    csrfToken: string,
    presentationSessionId: string,
    files: readonly File[],
  ): Promise<ReferenceDocumentUploadView>;
  listReferenceDocuments?(
    presentationSessionId: string,
  ): Promise<readonly ReferenceDocumentSummaryView[]>;
  readLiveCandidates(presentationSessionId: string): Promise<LiveCandidateSnapshotView>;
  approveLiveCandidate(
    csrfToken: string,
    snapshot: LiveCandidateSnapshotView,
    candidate: LiveCandidateSnapshotView["candidates"][number],
    approvalId: string,
  ): Promise<void>;
  approveDisplay?(
    csrfToken: string,
    presentation: ActivePresentationView,
    join: DisplayJoinView,
  ): Promise<DisplayBindingView>;
  setSlide?(
    csrfToken: string,
    input: Readonly<{
      presentationSessionId: string;
      publicSlideKey: string;
      displayBindingEpoch: string;
      baseRevision: string;
    }>,
  ): Promise<PlaybackCommandView>;
  endPresentationAndAwaitReport?(
    csrfToken: string,
    presentationSessionId: string,
  ): Promise<SessionReportView>;
  // Post-talk Q&A defense, mounted on the report surface the end action navigates to.
  openQaDefense?(csrfToken: string, presentationSessionId: string): Promise<QaDefenseLifecycle>;
  submitQaDefenseQuestion?(
    csrfToken: string,
    request: QaDefenseQuestionRequest,
    signal?: AbortSignal,
  ): Promise<QaDefenseAnswer>;
  readFinalizedReport?(presentationSessionId: string): Promise<SessionReportReadView>;
}

export interface ConsoleDeckUploadClient extends ConsoleSessionClient {
  uploadDeck(csrfToken: string, file: File, options?: UploadDeckOptions): Promise<DeckUploadView>;
}

export function createConsoleSessionClient(
  baseUrl = "",
  options: ConsoleSessionClientOptions = {},
): ConsoleDeckUploadClient {
  const context: PrivateClientContext = {
    baseUrl,
    createReportEventSource:
      options.createReportEventSource ?? ((url) => new EventSource(url, { withCredentials: true })),
    reportReadyTimeoutMs: options.reportReadyTimeoutMs ?? 10_000,
  };
  return {
    signUp: (username, password) => signUp(context, username, password),
    signIn: (username, password) => signIn(context, username, password),
    readSession: () => readSession(context),
    signOut: (csrfToken) => signOut(context, csrfToken),
    createPresentation: (csrfToken, artifacts) => createPresentation(context, csrfToken, artifacts),
    recommend: (csrfToken, request, signal) => recommend(context, csrfToken, request, signal),
    uploadReferenceDocuments: (csrfToken, presentationSessionId, files) =>
      uploadReferenceDocuments(context, csrfToken, presentationSessionId, files),
    listReferenceDocuments: (presentationSessionId) =>
      listReferenceDocuments(context, presentationSessionId),
    readLiveCandidates: (presentationSessionId) =>
      readLiveCandidates(context, presentationSessionId),
    approveLiveCandidate: (csrfToken, snapshot, candidate, approvalId) =>
      approveLiveCandidate(context, csrfToken, snapshot, candidate, approvalId),
    approveDisplay: (csrfToken, presentation, join) =>
      approveDisplay(context, csrfToken, presentation, join),
    setSlide: (csrfToken, input) => setSlide(context, csrfToken, input),
    endPresentationAndAwaitReport: (csrfToken, presentationSessionId) =>
      endPresentationAndAwaitReport(context, csrfToken, presentationSessionId),
    readFinalizedReport: (presentationSessionId) =>
      readFinalizedReport(context, presentationSessionId),
    openQaDefense: (csrfToken, presentationSessionId) =>
      openQaDefense(context, csrfToken, presentationSessionId),
    submitQaDefenseQuestion: (csrfToken, request) =>
      submitQaDefenseQuestion(context, csrfToken, request),
    uploadDeck: (csrfToken, file, uploadOptions) =>
      uploadDeck(context, csrfToken, file, uploadOptions),
  };
}

// Assembles the console's private-backend client from the responsibility modules.
// The client object is the only seam App.tsx and the tests consume; each capability
// delegates to one module and adds no behavior of its own.

import { type DeckUploadView, type UploadDeckOptions, uploadDeck } from "./deck-upload";
import {
  type DisplayInvitationPendingView,
  type IssuedStageInvitationView,
  issueDisplayInvitation,
  readDisplayInvitationPending,
} from "./display-invitations";
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
  deletePresentation,
  listPresentations,
  type PresentationDetailView,
  type PresentationListView,
  type PresentationSummaryView,
  readPresentation,
  renamePresentation,
  takeoverPlaybackLease,
} from "./presentation-library";
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
  type QaDefenseWindow,
  readQaDefenseWindow,
  type SpokenQuestionTranscription,
  submitQaDefenseQuestion,
  transcribeQuestionClip,
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
    expectedDisplayBindingEpoch: string,
  ): Promise<DisplayBindingView>;
  // The <=90s one-use Stage invitation: mint is owner-only, the pending read returns the
  // exact display identity plus the CAS epoch the approval is written against.
  issueDisplayInvitation?(
    csrfToken: string,
    presentationSessionId: string,
  ): Promise<IssuedStageInvitationView>;
  readDisplayInvitationPending?(invitationId: string): Promise<DisplayInvitationPendingView>;
  // Owner-scoped persisted library: returning presenters re-enter a deck they already
  // uploaded instead of re-uploading. Optional like the other late-added surfaces so narrow
  // injected test doubles stay valid.
  listPresentations?(options?: {
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<PresentationListView>;
  readPresentation?(presentationSessionId: string): Promise<PresentationDetailView>;
  renamePresentation?(
    csrfToken: string,
    presentationSessionId: string,
    title: string,
  ): Promise<PresentationSummaryView>;
  deletePresentation?(csrfToken: string, presentationSessionId: string): Promise<void>;
  takeoverPlaybackLease?(
    csrfToken: string,
    presentationSessionId: string,
    expectedDisplayBindingEpoch: string,
  ): Promise<{ readonly leaseActorId: string }>;
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
  /** Read-only ask-window recheck; powers the cockpit's expiry refetch chain. */
  readQaDefenseWindow?(csrfToken: string, presentationSessionId: string): Promise<QaDefenseWindow>;
  submitQaDefenseQuestion?(
    csrfToken: string,
    request: QaDefenseQuestionRequest,
    signal?: AbortSignal,
  ): Promise<QaDefenseAnswer>;
  // One spoken-question clip (WebM/Opus) transcribed server-side by the pinned local STT.
  transcribeQuestionClip?(
    csrfToken: string,
    audio: Blob,
    durationMs: number,
  ): Promise<SpokenQuestionTranscription>;
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
    approveDisplay: (csrfToken, presentation, join, expectedDisplayBindingEpoch) =>
      approveDisplay(context, csrfToken, presentation, join, expectedDisplayBindingEpoch),
    issueDisplayInvitation: (csrfToken, presentationSessionId) =>
      issueDisplayInvitation(context, csrfToken, presentationSessionId),
    readDisplayInvitationPending: (invitationId) =>
      readDisplayInvitationPending(context, invitationId),
    listPresentations: (options) => listPresentations(context, options),
    readPresentation: (presentationSessionId) => readPresentation(context, presentationSessionId),
    renamePresentation: (csrfToken, presentationSessionId, title) =>
      renamePresentation(context, csrfToken, presentationSessionId, title),
    deletePresentation: (csrfToken, presentationSessionId) =>
      deletePresentation(context, csrfToken, presentationSessionId),
    takeoverPlaybackLease: (csrfToken, presentationSessionId, expectedDisplayBindingEpoch) =>
      takeoverPlaybackLease(context, csrfToken, presentationSessionId, expectedDisplayBindingEpoch),
    setSlide: (csrfToken, input) => setSlide(context, csrfToken, input),
    endPresentationAndAwaitReport: (csrfToken, presentationSessionId) =>
      endPresentationAndAwaitReport(context, csrfToken, presentationSessionId),
    readFinalizedReport: (presentationSessionId) =>
      readFinalizedReport(context, presentationSessionId),
    openQaDefense: (csrfToken, presentationSessionId) =>
      openQaDefense(context, csrfToken, presentationSessionId),
    readQaDefenseWindow: (csrfToken, presentationSessionId) =>
      readQaDefenseWindow(context, csrfToken, presentationSessionId),
    submitQaDefenseQuestion: (csrfToken, request, signal) =>
      submitQaDefenseQuestion(context, csrfToken, request, signal),
    transcribeQuestionClip: (csrfToken, audio, durationMs) =>
      transcribeQuestionClip(context, csrfToken, audio, durationMs),
    uploadDeck: (csrfToken, file, uploadOptions) =>
      uploadDeck(context, csrfToken, file, uploadOptions),
  };
}

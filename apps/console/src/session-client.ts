export interface RecommendationRequest {
  readonly query: string;
  readonly deckVersion: string;
  readonly manifestHash: string;
  readonly maxResults: number;
}

export type RecommendationOutcome =
  | Readonly<{
      outcome: "RECOMMEND";
      recommendation: unknown;
      evidence: readonly unknown[];
      completedAtMs: number;
      latencyMs: number;
    }>
  | Readonly<{
      outcome: "ABSTAIN";
      reason: string;
      completedAtMs: number;
      latencyMs: number;
    }>;

export interface AccountSessionView {
  readonly account: { readonly accountId: string; readonly actorId: string };
  readonly expiresAtMs: number;
  readonly csrfToken: string;
}

export interface PresentationSessionView {
  readonly lifecycle: {
    readonly presentationSessionId: string;
    readonly presentationSessionEpoch: string;
    readonly deckVersion: string;
    readonly status: "ACTIVE" | "ENDED";
  };
}

export interface LiveCandidateSnapshotView {
  readonly authoritativeSnapshotHash: string;
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly publicationPolicyVersion: string;
  readonly publicationAuthorityId: string;
  readonly publicCardRevision: string;
  readonly livePublicEnabled: boolean;
  readonly candidates: readonly Readonly<{
    candidateId: string;
    candidateVersion: string;
    candidateRevision: string;
    claimText: string;
    evidenceExcerpt: string;
    occurrence: Readonly<{ publicSlideKey: string; occurrenceSeq: number }>;
  }>[];
}

export interface ConsoleSessionClient {
  signIn(authorizationCode: string): Promise<AccountSessionView>;
  readSession(): Promise<AccountSessionView | null>;
  signOut(csrfToken: string): Promise<void>;
  createPresentation(
    csrfToken: string,
    artifacts: { readonly privateDeck: unknown; readonly publicDeck: unknown },
  ): Promise<PresentationSessionView>;
  recommend(csrfToken: string, request: RecommendationRequest): Promise<RecommendationOutcome>;
  readLiveCandidates(presentationSessionId: string): Promise<LiveCandidateSnapshotView>;
  approveLiveCandidate(
    csrfToken: string,
    snapshot: LiveCandidateSnapshotView,
    candidate: LiveCandidateSnapshotView["candidates"][number],
    approvalId: string,
  ): Promise<void>;
}

export const DECK_UPLOAD_MIME_TYPES = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
} as const;

export type DeckUploadMimeType =
  (typeof DECK_UPLOAD_MIME_TYPES)[keyof typeof DECK_UPLOAD_MIME_TYPES];

export interface DeckUploadView {
  readonly presentationSessionId: string;
  readonly deckVersion: string;
  readonly sourceHash?: string;
  readonly privateDeck?: unknown;
  readonly publicDeck?: unknown;
}

export interface DeckUploadProgress {
  readonly loadedBytes: number;
  readonly totalBytes: number;
}

export interface DeckUploadProgressEvent {
  readonly lengthComputable?: boolean;
  readonly loaded?: number;
  readonly total?: number;
}

/** Minimal transport surface of XMLHttpRequest used by the multipart deck upload. */
export interface DeckUploadXhr {
  withCredentials: boolean;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: unknown): void;
  abort(): void;
  readonly upload: { onprogress: ((event: DeckUploadProgressEvent) => void) | null };
  onload: ((event: DeckUploadProgressEvent) => void) | null;
  onerror: ((event: DeckUploadProgressEvent) => void) | null;
  onabort: ((event: DeckUploadProgressEvent) => void) | null;
  ontimeout: ((event: DeckUploadProgressEvent) => void) | null;
  status: number;
  responseText: string;
}

export interface UploadDeckOptions {
  readonly transport?: DeckUploadXhr;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DeckUploadProgress) => void;
}

export class DeckUploadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, options: { readonly status: number; readonly cause?: unknown }) {
    if (options.cause === undefined) {
      super(code);
    } else {
      super(code, { cause: options.cause });
    }
    this.name = "DeckUploadError";
    this.code = code;
    this.status = options.status;
  }
}

export interface ConsoleDeckUploadClient extends ConsoleSessionClient {
  uploadDeck(csrfToken: string, file: File, options?: UploadDeckOptions): Promise<DeckUploadView>;
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isAccountSessionView(value: unknown): value is AccountSessionView {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const account = candidate.account;
  return (
    typeof account === "object" &&
    account !== null &&
    typeof (account as Record<string, unknown>).accountId === "string" &&
    typeof (account as Record<string, unknown>).actorId === "string" &&
    typeof candidate.expiresAtMs === "number" &&
    typeof candidate.csrfToken === "string"
  );
}

function isRecommendationOutcome(value: unknown): value is RecommendationOutcome {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.completedAtMs !== "number" || typeof candidate.latencyMs !== "number") {
    return false;
  }
  return candidate.outcome === "ABSTAIN"
    ? typeof candidate.reason === "string"
    : candidate.outcome === "RECOMMEND" && Array.isArray(candidate.evidence);
}

function isLiveCandidateSnapshot(value: unknown): value is LiveCandidateSnapshotView {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.authoritativeSnapshotHash !== "string" ||
    typeof candidate.presentationSessionId !== "string" ||
    typeof candidate.presentationSessionEpoch !== "string" ||
    typeof candidate.publicationPolicyVersion !== "string" ||
    typeof candidate.publicationAuthorityId !== "string" ||
    typeof candidate.publicCardRevision !== "string" ||
    typeof candidate.livePublicEnabled !== "boolean" ||
    !Array.isArray(candidate.candidates)
  ) {
    return false;
  }
  return candidate.candidates.every((valueCandidate) => {
    if (typeof valueCandidate !== "object" || valueCandidate === null) return false;
    const live = valueCandidate as Record<string, unknown>;
    const occurrence = live.occurrence;
    return (
      typeof live.candidateId === "string" &&
      typeof live.candidateVersion === "string" &&
      typeof live.candidateRevision === "string" &&
      typeof live.claimText === "string" &&
      typeof live.evidenceExcerpt === "string" &&
      typeof occurrence === "object" &&
      occurrence !== null &&
      typeof (occurrence as Record<string, unknown>).publicSlideKey === "string" &&
      typeof (occurrence as Record<string, unknown>).occurrenceSeq === "number"
    );
  });
}

function isPresentationSessionView(value: unknown): value is PresentationSessionView {
  if (typeof value !== "object" || value === null) return false;
  const lifecycle = (value as Record<string, unknown>).lifecycle;
  if (typeof lifecycle !== "object" || lifecycle === null) return false;
  const candidate = lifecycle as Record<string, unknown>;
  return (
    typeof candidate.presentationSessionId === "string" &&
    typeof candidate.presentationSessionEpoch === "string" &&
    typeof candidate.deckVersion === "string" &&
    (candidate.status === "ACTIVE" || candidate.status === "ENDED")
  );
}

function createAbortError(): Error {
  return new DOMException("Deck upload was aborted.", "AbortError");
}

function deckUploadContentType(file: File): DeckUploadMimeType | null {
  if (file.type === DECK_UPLOAD_MIME_TYPES.pptx) return DECK_UPLOAD_MIME_TYPES.pptx;
  if (file.type === DECK_UPLOAD_MIME_TYPES.pdf) return DECK_UPLOAD_MIME_TYPES.pdf;
  return null;
}

function parseDeckUploadView(text: string, status: number): DeckUploadView {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (cause) {
    throw new DeckUploadError("invalid_upload_receipt", { status, cause });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DeckUploadError("invalid_upload_receipt", { status });
  }
  const candidate = body as Record<string, unknown>;
  const { presentationSessionId, deckVersion } = candidate;
  if (
    typeof presentationSessionId !== "string" ||
    presentationSessionId.length === 0 ||
    typeof deckVersion !== "string" ||
    deckVersion.length === 0
  ) {
    throw new DeckUploadError("invalid_upload_receipt", { status });
  }
  return {
    presentationSessionId,
    deckVersion,
    ...(typeof candidate.sourceHash === "string" ? { sourceHash: candidate.sourceHash } : {}),
    ...(candidate.privateDeck !== undefined ? { privateDeck: candidate.privateDeck } : {}),
    ...(candidate.publicDeck !== undefined ? { publicDeck: candidate.publicDeck } : {}),
  };
}

function decodeBackendError(text: string, status: number): DeckUploadError {
  let code = status === 0 ? "network_error" : "upload_rejected";
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null) {
      const reported = (body as Record<string, unknown>).error;
      if (typeof reported === "string" && reported.length > 0) code = reported;
    }
  } catch {
    // The body is not a JSON backend error payload; keep the fallback code.
  }
  return new DeckUploadError(code, { status });
}

export function createConsoleSessionClient(baseUrl = ""): ConsoleDeckUploadClient {
  const mutationHeaders = (csrfToken?: string) => ({
    "content-type": "application/json",
    ...(csrfToken === undefined ? {} : { "x-csrf-token": csrfToken }),
  });
  return {
    async signIn(authorizationCode) {
      const response = await fetch(`${baseUrl}/v1/account-sessions`, {
        method: "POST",
        credentials: "include",
        headers: mutationHeaders(),
        body: JSON.stringify({ authorizationCode }),
      });
      const body = await responseBody(response);
      if (!response.ok || !isAccountSessionView(body)) throw new Error("Sign-in was rejected.");
      return body;
    },
    async readSession() {
      const response = await fetch(`${baseUrl}/v1/account-session`, { credentials: "include" });
      if (response.status === 401) return null;
      const body = await responseBody(response);
      if (!response.ok || !isAccountSessionView(body))
        throw new Error("Session could not be read.");
      return body;
    },
    async signOut(csrfToken) {
      const response = await fetch(`${baseUrl}/v1/account-session`, {
        method: "DELETE",
        credentials: "include",
        headers: mutationHeaders(csrfToken),
      });
      if (!response.ok) throw new Error("Sign-out was rejected.");
    },
    async recommend(csrfToken, request) {
      const response = await fetch(`${baseUrl}/v1/recommendations`, {
        method: "POST",
        credentials: "include",
        headers: mutationHeaders(csrfToken),
        body: JSON.stringify(request),
      });
      const body = await responseBody(response);
      if (!response.ok || !isRecommendationOutcome(body)) {
        throw new Error("Recommendation request failed.");
      }
      return body;
    },
    async readLiveCandidates(presentationSessionId) {
      const response = await fetch(
        `${baseUrl}/v1/publications/live-candidates?presentationSessionId=${encodeURIComponent(presentationSessionId)}`,
        { credentials: "include" },
      );
      const body = await responseBody(response);
      if (!response.ok || !isLiveCandidateSnapshot(body)) {
        throw new Error("A fresh live-candidate snapshot could not be read.");
      }
      return body;
    },
    async approveLiveCandidate(csrfToken, snapshot, candidate, approvalId) {
      const response = await fetch(`${baseUrl}/v1/publications/approve`, {
        method: "POST",
        credentials: "include",
        headers: mutationHeaders(csrfToken),
        body: JSON.stringify({
          presentationSessionId: snapshot.presentationSessionId,
          candidateId: candidate.candidateId,
          candidateVersion: candidate.candidateVersion,
          expectedCandidateRevision: candidate.candidateRevision,
          expectedPublicCardRevision: snapshot.publicCardRevision,
          authorityId: snapshot.publicationAuthorityId,
          approvalId,
          authoritativeSnapshotHash: snapshot.authoritativeSnapshotHash,
          expiresAtMs: null,
        }),
      });
      if (!response.ok) {
        const body = await responseBody(response);
        const reason =
          typeof body === "object" && body !== null
            ? (body as Record<string, unknown>).error
            : null;
        throw new Error(typeof reason === "string" ? reason : "approval_rejected");
      }
    },
    async createPresentation(csrfToken, artifacts) {
      const response = await fetch(`${baseUrl}/v1/presentation-sessions`, {
        method: "POST",
        credentials: "include",
        headers: mutationHeaders(csrfToken),
        body: JSON.stringify(artifacts),
      });
      const body = await responseBody(response);
      if (!response.ok || !isPresentationSessionView(body)) {
        throw new Error("Presentation session could not be created.");
      }
      return body;
    },
    uploadDeck(csrfToken, file, options = {}) {
      const contentType = deckUploadContentType(file);
      if (contentType === null || typeof file.name !== "string" || file.name.length === 0) {
        return Promise.reject(new DeckUploadError("unsupported_deck_file", { status: 0 }));
      }
      const signal = options.signal;
      if (signal?.aborted) {
        return Promise.reject(createAbortError());
      }
      const transport = options.transport ?? new XMLHttpRequest();
      transport.withCredentials = true;
      const url = `${baseUrl}/v1/deck-uploads`;
      return new Promise<DeckUploadView>((resolve, reject) => {
        const abortError = createAbortError();
        let settled = false;
        const finish = (execute: () => void) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          transport.upload.onprogress = null;
          execute();
        };
        const complete = (view: DeckUploadView) => finish(() => resolve(view));
        const rejectWith = (error: Error) => finish(() => reject(error));
        const onAbort = () => {
          transport.abort();
          rejectWith(abortError);
        };
        transport.onabort = () => rejectWith(abortError);
        transport.onerror = () => rejectWith(new DeckUploadError("network_error", { status: 0 }));
        transport.ontimeout = () =>
          rejectWith(new DeckUploadError("upload_timeout", { status: 0 }));
        transport.onload = () => {
          if (transport.status !== 201) {
            rejectWith(decodeBackendError(transport.responseText, transport.status));
            return;
          }
          try {
            complete(parseDeckUploadView(transport.responseText, transport.status));
          } catch (cause) {
            rejectWith(
              cause instanceof DeckUploadError
                ? cause
                : new DeckUploadError("invalid_upload_receipt", {
                    status: transport.status,
                    cause,
                  }),
            );
          }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        transport.open("POST", url);
        transport.setRequestHeader("x-csrf-token", csrfToken);
        transport.upload.onprogress = (event: DeckUploadProgressEvent) => {
          options.onProgress?.({
            loadedBytes: typeof event.loaded === "number" ? event.loaded : 0,
            totalBytes:
              typeof event.total === "number" && event.total > 0 ? event.total : file.size,
          });
        };
        const form = new FormData();
        form.append("file", file);
        transport.send(form);
      });
    },
  };
}

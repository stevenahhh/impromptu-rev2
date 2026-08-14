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

export function createConsoleSessionClient(baseUrl = ""): ConsoleSessionClient {
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
  };
}

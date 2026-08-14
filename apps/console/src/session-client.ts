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

export interface ConsoleSessionClient {
  signIn(authorizationCode: string): Promise<AccountSessionView>;
  readSession(): Promise<AccountSessionView | null>;
  signOut(csrfToken: string): Promise<void>;
  createPresentation(
    csrfToken: string,
    artifacts: { readonly privateDeck: unknown; readonly publicDeck: unknown },
  ): Promise<PresentationSessionView>;
  recommend(csrfToken: string, request: RecommendationRequest): Promise<RecommendationOutcome>;
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

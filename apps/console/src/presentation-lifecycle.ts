// Presentation session creation and the active-presentation view shared by the
// display-binding flow.

import { mutationHeaders, type PrivateClientContext, responseBody } from "./private-transport";

export interface PresentationSessionView {
  readonly lifecycle: {
    readonly presentationSessionId: string;
    readonly presentationSessionEpoch: string;
    readonly deckVersion: string;
    readonly status: "ACTIVE" | "ENDED";
  };
}

export interface ActivePresentationView {
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly deckVersion: string;
  readonly manifestHash?: string;
  readonly slides: readonly Readonly<{
    publicSlideKey: string;
    ordinal: number;
    accessibilityLabel: string;
    image?: Readonly<{
      url: string;
      contentHash: string;
      width: number;
      height: number;
    }>;
  }>[];
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

export async function createPresentation(
  context: PrivateClientContext,
  csrfToken: string,
  artifacts: { readonly privateDeck: unknown; readonly publicDeck: unknown },
): Promise<PresentationSessionView> {
  const response = await fetch(`${context.baseUrl}/v1/presentation-sessions`, {
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
}

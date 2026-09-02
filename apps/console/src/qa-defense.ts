// Q&A-defense calls against the private backend: opening the post-talk session,
// asking an audience question, and the closed parsing of grounded answers or honest
// abstentions into views the presenter surface can render without reinterpretation.

import type { PresentationSessionView } from "./presentation-lifecycle";
import {
  externalSourceUrl,
  mutationHeaders,
  type PrivateClientContext,
  responseBody,
} from "./private-transport";

export type QaDefenseLifecycle = PresentationSessionView["lifecycle"];

export interface QaDefenseQuestionRequest {
  readonly presentationSessionId: string;
  readonly questionText: string;
  readonly origin: "TYPED" | "SPOKEN";
}

export type QaDefenseCitation =
  | Readonly<{
      kind: "DECK_SLIDE";
      evidenceId: string;
      slideOrdinal: number;
      title: string;
      quote: string;
    }>
  | Readonly<{
      kind: "REFERENCE_DOCUMENT";
      evidenceId: string;
      documentTitle: string;
      chunkOrdinal: number;
      quote: string;
    }>
  | Readonly<{
      kind: "EXTERNAL_SOURCE";
      evidenceId: string;
      title: string;
      url: string;
      quote: string;
    }>;

export type QaDefenseAnswer =
  | Readonly<{
      outcome: "ANSWERED";
      answer: string;
      citations: readonly QaDefenseCitation[];
      latencyMs: number;
      completedAtMs: number;
    }>
  | Readonly<{
      outcome: "ABSTAINED";
      reason: string;
      retryable: boolean;
      latencyMs: number;
      completedAtMs: number;
    }>;

/** Questions are rejected until the presenter explicitly opened this session's Q&A. */
export class QaDefenseNotOpenError extends Error {}

function citation(value: unknown): QaDefenseCitation | null {
  if (typeof value !== "object" || value === null) return null;
  const evidenceId = Reflect.get(value, "evidenceId");
  const quote = Reflect.get(value, "quote");
  if (typeof evidenceId !== "string" || typeof quote !== "string") return null;
  const kind = Reflect.get(value, "kind");
  if (kind === "DECK_SLIDE") {
    const slideOrdinal = Reflect.get(value, "slideOrdinal");
    const title = Reflect.get(value, "title");
    return typeof slideOrdinal === "number" && typeof title === "string"
      ? { kind, evidenceId, slideOrdinal, title, quote }
      : null;
  }
  if (kind === "REFERENCE_DOCUMENT") {
    const documentTitle = Reflect.get(value, "documentTitle");
    const chunkOrdinal = Reflect.get(value, "chunkOrdinal");
    return typeof documentTitle === "string" && typeof chunkOrdinal === "number"
      ? { kind, evidenceId, documentTitle, chunkOrdinal, quote }
      : null;
  }
  if (kind === "EXTERNAL_SOURCE") {
    const title = Reflect.get(value, "title");
    const url = externalSourceUrl(Reflect.get(value, "url"));
    return typeof title === "string" && url !== null
      ? { kind, evidenceId, title, url, quote }
      : null;
  }
  return null;
}

function answer(value: unknown): QaDefenseAnswer | null {
  if (typeof value !== "object" || value === null) return null;
  const latencyMs = Reflect.get(value, "latencyMs");
  const completedAtMs = Reflect.get(value, "completedAtMs");
  if (typeof latencyMs !== "number" || typeof completedAtMs !== "number") return null;
  const outcome = Reflect.get(value, "outcome");
  if (outcome === "ABSTAINED") {
    const reason = Reflect.get(value, "reason");
    const retryable = Reflect.get(value, "retryable");
    return typeof reason === "string" && typeof retryable === "boolean"
      ? { outcome, reason, retryable, latencyMs, completedAtMs }
      : null;
  }
  if (outcome !== "ANSWERED") return null;
  const text = Reflect.get(value, "answer");
  const citations = Reflect.get(value, "citations");
  if (typeof text !== "string" || !Array.isArray(citations)) return null;
  const parsed = citations.flatMap((entry) => {
    const card = citation(entry);
    // Closed at both ends: one bad citation makes the whole receipt unreadable rather than
    // leaving a claim supported by sources nobody can audit.
    return card === null ? [null] : [card];
  });
  if (parsed.some((entry) => entry === null)) return null;
  const settledCitations = parsed as readonly QaDefenseCitation[];
  if (settledCitations.length === 0 || settledCitations.length > 3) return null;
  return { outcome, answer: text, citations: settledCitations, latencyMs, completedAtMs };
}

function qaLifecycle(value: unknown): QaDefenseLifecycle | null {
  if (typeof value !== "object" || value === null) return null;
  const presentationSessionId = Reflect.get(value, "presentationSessionId");
  const presentationSessionEpoch = Reflect.get(value, "presentationSessionEpoch");
  const deckVersion = Reflect.get(value, "deckVersion");
  const status = Reflect.get(value, "status");
  if (
    typeof presentationSessionId !== "string" ||
    typeof presentationSessionEpoch !== "string" ||
    typeof deckVersion !== "string" ||
    (status !== "ACTIVE" && status !== "ENDED")
  ) {
    return null;
  }
  return { presentationSessionId, presentationSessionEpoch, deckVersion, status };
}

/**
 * Opens the post-talk Q&A session. The response carries the session lifecycle so callers can
 * react to endedness without a second read.
 */
export async function openQaDefense(
  context: PrivateClientContext,
  csrfToken: string,
  presentationSessionId: string,
): Promise<QaDefenseLifecycle> {
  const response = await fetch(
    `${context.baseUrl}/v1/presentation-sessions/${encodeURIComponent(presentationSessionId)}/qa-defense`,
    {
      method: "POST",
      credentials: "include",
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({ presentationSessionId }),
    },
  );
  const body = await responseBody(response);
  const lifecycle =
    typeof body === "object" && body !== null ? qaLifecycle(Reflect.get(body, "lifecycle")) : null;
  if (!response.ok || lifecycle === null) {
    throw new Error("The Q&A defense session could not be opened.");
  }
  return lifecycle;
}

export async function submitQaDefenseQuestion(
  context: PrivateClientContext,
  csrfToken: string,
  request: QaDefenseQuestionRequest,
  signal?: AbortSignal,
): Promise<QaDefenseAnswer> {
  const response = await fetch(`${context.baseUrl}/v1/qa-defense`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(csrfToken),
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal }),
  });
  const body = await responseBody(response);
  const parsed = answer(body);
  if (!response.ok || parsed === null) {
    const error =
      typeof body === "object" && body !== null ? Reflect.get(body, "error") : undefined;
    if (response.status === 409 && error === "qa_not_open") {
      throw new QaDefenseNotOpenError("The Q&A defense session is not open.");
    }
    throw new Error("The Q&A defense request failed.");
  }
  return parsed;
}

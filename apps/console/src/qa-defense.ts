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

export const QUESTION_CLIP_MIME_TYPE = "audio/webm;codecs=opus" as const;
const QUESTION_CLIP_TRANSCRIPTION_URL = "/v1/question-clips/transcription";
// Mirror of contracts' SpokenQuestionTranscriptionRejectionSchema without pulling zod into
// the browser bundle — an unknown reason fails loudly instead of rendering as success.
const CLIP_REJECTION_REASONS: ReadonlySet<string> = new Set([
  "EMPTY_AUDIO",
  "TOO_LARGE",
  "TOO_LONG",
  "UNSUPPORTED_CODEC",
  "STT_UNAVAILABLE",
  "TRANSCRIPTION_FAILED",
]);

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

/**
 * Closed view of ONE spoken-question clip transcription. TRANSCRIBED carries the presenter-
 * editable transcript; REJECTED preserves the typed reason so failure copy can be honest.
 */
export type SpokenQuestionTranscription =
  | Readonly<{ outcome: "TRANSCRIBED"; text: string }>
  | Readonly<{ outcome: "REJECTED"; reason: string }>;

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

/**
 * Uploads one bounded question clip for server-side STT via the private backend's pinned
 * local adapter. Rejections arrive as a typed outcome (HTTP 200) — an honest rejection is a
 * result, not a transport error; only a non-2xx or unreadable body throws.
 */
export async function transcribeQuestionClip(
  context: PrivateClientContext,
  csrfToken: string,
  audio: Blob,
  durationMs: number,
): Promise<SpokenQuestionTranscription> {
  const response = await fetch(`${context.baseUrl}${QUESTION_CLIP_TRANSCRIPTION_URL}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "x-csrf-token": csrfToken,
      "content-type": QUESTION_CLIP_MIME_TYPE,
      "x-audio-duration-ms": String(Math.max(0, Math.floor(durationMs))),
    },
    body: audio,
  });
  if (!response.ok) throw new Error("The question clip could not be transcribed.");
  const body = await responseBody(response);
  if (typeof body !== "object" || body === null) {
    throw new Error("The question clip transcription was unreadable.");
  }
  const outcome = Reflect.get(body, "outcome");
  if (outcome === "TRANSCRIBED") {
    const text = Reflect.get(body, "text");
    if (typeof text === "string" && text.trim().length > 0) return { outcome, text };
    throw new Error("The question clip transcription was unreadable.");
  }
  if (outcome === "REJECTED") {
    const reason = Reflect.get(body, "reason");
    // Closed at this end too: an unknown reason cannot render fabricated success, it fails loudly.
    if (typeof reason === "string" && CLIP_REJECTION_REASONS.has(reason)) {
      return { outcome, reason };
    }
  }
  throw new Error("The question clip transcription was unreadable.");
}

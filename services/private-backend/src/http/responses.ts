import {
  type ReferenceDocumentRejectionReason,
  type ReferenceDocumentUploadOutcome,
  ReferenceDocumentUploadOutcomeSchema,
} from "@impromptu/contracts/private";
import type { DeckUploadRejectionCode } from "../deck-upload-worker.ts";
import type { DeckUploadRejectedResponse } from "./types.ts";

const DECK_UPLOAD_REJECTION_STATUS = {
  empty_input: 400,
  unsupported_extension: 400,
  malformed_input: 400,
  input_too_large: 413,
  unsafe_filename: 400,
  size_mismatch: 400,
} as const satisfies Record<DeckUploadRejectionCode, 400 | 413>;

const REFERENCE_REJECTION_STATUS = {
  EMPTY_INPUT: 400,
  MALFORMED_INPUT: 400,
  UNSUPPORTED_TYPE: 400,
  UNSAFE_FILENAME: 400,
  TOO_MANY_FILES: 400,
  TOO_LARGE: 413,
  EXTRACTION_FAILED: 422,
  PRESENTATION_UNKNOWN: 404,
} as const satisfies Record<ReferenceDocumentRejectionReason, number>;

export function json(body: unknown, status: number, headers?: Headers): Response {
  const responseHeaders = headers ?? new Headers();
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

export function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    },
  });
}

export function rateLimited(
  reason: "ACCOUNT_RATE_LIMITED" | "IP_RATE_LIMITED",
  retryAfterMs: number,
  headers: Headers,
): Response {
  headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  return json({ outcome: "REJECTED", reason, retryAfterMs }, 429, headers);
}

const responseOutcomes = new WeakMap<Response, string>();

export function observeResponseOutcome(response: Response, outcome: string): Response {
  responseOutcomes.set(response, outcome);
  return response;
}

export function responseOutcome(response: Response, fallback: string): string {
  return responseOutcomes.get(response) ?? fallback;
}

export function deckUploadRejected(code: DeckUploadRejectionCode, headers: Headers): Response {
  return json(
    { error: "deck_upload_rejected", code } satisfies DeckUploadRejectedResponse,
    DECK_UPLOAD_REJECTION_STATUS[code],
    headers,
  );
}

export function audioRejection(reason: string, headers: Headers): Response {
  const status =
    reason === "CAPTURE_GRANT_REQUIRED" ? 401 : reason === "GRANT_SESSION_MISMATCH" ? 403 : 409;
  return json({ error: reason }, status, headers);
}

export function referenceUploadRejection(
  outcome: Extract<ReferenceDocumentUploadOutcome, { outcome: "REJECTED" }>,
  headers: Headers,
): Response {
  return json(
    ReferenceDocumentUploadOutcomeSchema.parse(outcome),
    REFERENCE_REJECTION_STATUS[outcome.reason],
    headers,
  );
}

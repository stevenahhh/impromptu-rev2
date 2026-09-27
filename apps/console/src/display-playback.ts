// Audience-display binding approval and playback slide commands.

import type { ActivePresentationView } from "./presentation-lifecycle";
import {
  mutationHeaders,
  type PrivateClientContext,
  responseBody,
  stringField,
} from "./private-transport";

export interface DisplayJoinView {
  readonly displayJoinId: string;
  readonly displayId: string;
  readonly displayFingerprint: string;
  readonly deckVersion: string;
  readonly expiresAtMs: number;
}

export interface DisplayBindingView {
  readonly displayBindingEpoch: string;
}

/**
 * The backend answers a refused playback command with 409 `{"error": "<reason>"}` where the
 * reason is the exact receipt reason (see reducePlaybackCommand in @impromptu/state playback).
 * Callers distinguish "this display binding is dead" (STALE_DISPLAY_BINDING) from a superseded
 * control revision (REVISION_MISMATCH) and other refusals, so the reason travels on the error.
 */
export class PlaybackCommandRejectedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Playback command was rejected: ${reason}`);
    this.name = "PlaybackCommandRejectedError";
    this.reason = reason;
  }
}

/**
 * A display-binding approval refused by the backend (409 `{ "error": "<reason>" }`).
 * `STALE_DISPLAY_BINDING` means the expected CAS epoch no longer matches the server's
 * current binding epoch — the only answer is a fresh read, never a retry of the same
 * epoch. Other reasons (WRONG_DECK, UNAUTHORIZED, ...) stay verbatim for the UI.
 */
export class DisplayApprovalRejectedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Audience screen approval was rejected: ${reason}`);
    this.name = "DisplayApprovalRejectedError";
    this.reason = reason;
  }
}

function rejectionReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" ? error : null;
}

export interface PlaybackCommandView {
  readonly acceptedControlRevision: string;
}

export async function approveDisplay(
  context: PrivateClientContext,
  csrfToken: string,
  presentation: ActivePresentationView,
  join: DisplayJoinView,
  // The CAS epoch must be the one the presenter just read or the console currently holds —
  // the backend compares it to its live playback.displayBindingEpoch and refuses stale
  // writes, so a constant here (the old hardcoded "dbe_0") strands every rebind.
  expectedDisplayBindingEpoch: string,
): Promise<DisplayBindingView> {
  const response = await fetch(`${context.baseUrl}/v1/display-bindings`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(csrfToken),
    body: JSON.stringify({
      presentationSessionId: presentation.presentationSessionId,
      displayJoinId: join.displayJoinId,
      expectedDisplayBindingEpoch,
      expectedDeckVersion: presentation.deckVersion,
      approvedDisplayId: join.displayId,
      approvedDisplayFingerprint: join.displayFingerprint,
    }),
  });
  const body = await responseBody(response);
  const binding =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).binding : null;
  // The endpoint answers an applied approval with the strict AudienceDisplaySession DTO, so
  // the epoch only ever lives at binding.displayBindingEpoch; anything else fails closed.
  const displayBindingEpoch = stringField(binding, "displayBindingEpoch");
  if (!response.ok || displayBindingEpoch === null) {
    const reason = rejectionReason(body);
    if (!response.ok && reason !== null) throw new DisplayApprovalRejectedError(reason);
    throw new Error("Audience screen approval failed.");
  }
  return { displayBindingEpoch };
}

export async function setSlide(
  context: PrivateClientContext,
  csrfToken: string,
  input: Readonly<{
    presentationSessionId: string;
    publicSlideKey: string;
    displayBindingEpoch: string;
    baseRevision: string;
  }>,
): Promise<PlaybackCommandView> {
  const response = await fetch(`${context.baseUrl}/v1/playback/slide-set`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(csrfToken),
    body: JSON.stringify({ ...input, commandId: `cmd_${crypto.randomUUID()}` }),
  });
  const body = await responseBody(response);
  const acceptedControlRevision = stringField(body, "acceptedControlRevision");
  if (!response.ok || acceptedControlRevision === null) {
    const reason = rejectionReason(body);
    if (reason !== null) throw new PlaybackCommandRejectedError(reason);
    throw new Error("Slide change was rejected.");
  }
  return { acceptedControlRevision };
}

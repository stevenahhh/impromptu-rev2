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
): Promise<DisplayBindingView> {
  const response = await fetch(`${context.baseUrl}/v1/display-bindings`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(csrfToken),
    body: JSON.stringify({
      presentationSessionId: presentation.presentationSessionId,
      displayJoinId: join.displayJoinId,
      expectedDisplayBindingEpoch: "dbe_0",
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

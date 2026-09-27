// Stage display invitations: owner-only minting of the <=90s one-use link plus the
// owner-scoped pending read that carries the display identity and the binding-epoch CAS
// the approval is written against. The token itself never leaves the fragment; the
// console only ever sees it embedded in `stagePath`.

import type { DisplayJoinView } from "./display-playback";
import {
  mutationHeaders,
  type PrivateClientContext,
  responseBody,
  stringField,
} from "./private-transport";

/** Minted invitation material: the token only ever lives inside `stagePath`'s fragment. */
export interface IssuedStageInvitationView {
  readonly invitationId: string;
  readonly deckVersion: string;
  readonly expiresAtMs: number;
  /** `/?deck=<deckVersion>#invite=dinv_<token>` — the secret is fragment-only. */
  readonly stagePath: string;
}

export type DisplayInvitationStatus = "PENDING" | "JOINED" | "EXPIRED";

/**
 * Owner-facing pending view: the exact display asking to connect plus the authoritative
 * binding epoch the approval CAS is written against. Never carries token material.
 */
export interface DisplayInvitationPendingView {
  readonly invitationId: string;
  readonly presentationSessionId: string;
  readonly deckVersion: string;
  readonly expiresAtMs: number;
  readonly status: DisplayInvitationStatus;
  readonly displayBindingEpoch: string;
  readonly join: DisplayJoinView | null;
}

/** Rejected invitation calls carry the backend's verbatim reason so callers fail closed. */
export class DisplayInvitationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "DisplayInvitationError";
    this.status = status;
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const INVITATION_ID_PATTERN = /^dinvite_[0-9a-f]{32}$/;
const BINDING_EPOCH_PATTERN = /^dbe_(0|[1-9][0-9]*)$/;
const STAGE_PATH_PATTERN = /^\/\?deck=[A-Za-z0-9][A-Za-z0-9._-]*#invite=dinv_[0-9a-f]{64}$/;

function displayJoin(value: unknown): DisplayJoinView | null {
  const candidate = record(value);
  if (candidate === null) return null;
  const { displayJoinId, displayId, displayFingerprint, deckVersion, expiresAtMs } = candidate;
  return typeof displayJoinId === "string" &&
    typeof displayId === "string" &&
    typeof displayFingerprint === "string" &&
    typeof deckVersion === "string" &&
    typeof expiresAtMs === "number"
    ? { displayJoinId, displayId, displayFingerprint, deckVersion, expiresAtMs }
    : null;
}

function issuedInvitation(value: unknown): IssuedStageInvitationView | null {
  const candidate = record(value);
  if (candidate === null) return null;
  const { invitationId, deckVersion, expiresAtMs, stagePath } = candidate;
  // stagePath is contract-pinned: fragment-carried token, never a query parameter that
  // access logs, referrers, or history would capture. Anything else fails closed.
  if (
    typeof invitationId !== "string" ||
    typeof deckVersion !== "string" ||
    typeof expiresAtMs !== "number" ||
    typeof stagePath !== "string" ||
    !STAGE_PATH_PATTERN.test(stagePath)
  ) {
    return null;
  }
  return { invitationId, deckVersion, expiresAtMs, stagePath };
}

function pendingView(value: unknown): DisplayInvitationPendingView | null {
  const candidate = record(value);
  if (candidate === null) return null;
  const {
    invitationId,
    presentationSessionId,
    deckVersion,
    expiresAtMs,
    status,
    displayBindingEpoch,
    join,
  } = candidate;
  if (
    typeof invitationId !== "string" ||
    !INVITATION_ID_PATTERN.test(invitationId) ||
    typeof presentationSessionId !== "string" ||
    typeof deckVersion !== "string" ||
    typeof expiresAtMs !== "number" ||
    (status !== "PENDING" && status !== "JOINED" && status !== "EXPIRED") ||
    typeof displayBindingEpoch !== "string" ||
    !BINDING_EPOCH_PATTERN.test(displayBindingEpoch)
  ) {
    return null;
  }
  const parsedJoin = join === null ? null : displayJoin(join);
  if (join !== null && parsedJoin === null) return null;
  return {
    invitationId,
    presentationSessionId,
    deckVersion,
    expiresAtMs,
    status,
    displayBindingEpoch,
    join: parsedJoin,
  };
}

function errorCode(body: unknown): string | null {
  return stringField(body, "error");
}

export async function issueDisplayInvitation(
  context: PrivateClientContext,
  csrfToken: string,
  presentationSessionId: string,
): Promise<IssuedStageInvitationView> {
  const response = await fetch(`${context.baseUrl}/v1/display-invitations`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(csrfToken),
    body: JSON.stringify({ presentationSessionId }),
  });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new DisplayInvitationError(response.status, errorCode(body) ?? "invitation_issue_failed");
  }
  const issued = issuedInvitation(body);
  if (issued === null) throw new DisplayInvitationError(response.status, "invalid_invitation");
  return issued;
}

export async function readDisplayInvitationPending(
  context: PrivateClientContext,
  invitationId: string,
): Promise<DisplayInvitationPendingView> {
  const response = await fetch(
    `${context.baseUrl}/v1/display-invitations/${encodeURIComponent(invitationId)}/pending`,
    { credentials: "include" },
  );
  const body = await responseBody(response);
  if (!response.ok) {
    throw new DisplayInvitationError(response.status, errorCode(body) ?? "invitation_read_failed");
  }
  const view = pendingView(body);
  if (view === null) throw new DisplayInvitationError(response.status, "invalid_pending_view");
  return view;
}

import type { EndPresentationResult } from "../prepared-evidence.ts";
import type {
  SessionReportPrincipal,
  SessionReportRepository,
} from "./postgres-session-report-repository.ts";
import type {
  PreparedEvidenceReportSnapshot,
  SessionEndAccepted,
  SessionReport,
} from "./session-report-finalizer.ts";

export type SessionReportReadRouteHandler = (
  request: Request,
  accountId: string,
  /** The authenticated account session id; the end branch needs it to act as the caller. */
  accountSessionId?: string,
) => Promise<Response | null>;

/**
 * Narrow seam over the prepared-evidence coordinator: the route may move the presentation
 * lifecycle as the authenticated account session without ever seeing the coordinator itself.
 */
export type SessionPresentationEndLifecycle = (
  input: Readonly<{
    accountSessionId: string;
    presentationSessionId: string;
  }>,
) => Promise<EndPresentationResult>;

export interface SessionReportOwnerResolver {
  resolve(input: {
    readonly accountId: string;
    readonly presentationSessionId: string;
  }): Promise<SessionReportPrincipal | null>;
}

export interface FinalizedSessionReportReader {
  readFinalizedReport(
    principal: SessionReportPrincipal,
    preparedEvidence: PreparedEvidenceReportSnapshot,
  ): Promise<SessionReport | null>;
}

export interface PreparedEvidenceReportSnapshotResolver {
  resolve(principal: SessionReportPrincipal): Promise<PreparedEvidenceReportSnapshot>;
}

export interface SessionReportEnder extends FinalizedSessionReportReader {
  endSession(input: {
    readonly principal: SessionReportPrincipal;
    readonly endedOffsetMs: number;
    readonly finalizedAtMs: number;
    readonly preparedEvidence: PreparedEvidenceReportSnapshot;
  }): Promise<SessionEndAccepted>;
}

export interface SessionReportEndContextResolver {
  resolve(principal: SessionReportPrincipal): Promise<Readonly<{
    endedOffsetMs: number;
    finalizedAtMs: number;
    preparedEvidence: PreparedEvidenceReportSnapshot;
  }> | null>;
}

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

/**
 * Handles only the authenticated private report-read route. http.ts supplies the
 * already authenticated account and resolves owner authority next to that boundary.
 */
export function createSessionReportReadRouteHandler(
  reports: SessionReportRepository,
  owners: SessionReportOwnerResolver,
): SessionReportReadRouteHandler {
  return async (request, accountId) => {
    if (request.method !== "GET") return null;
    const match = /^\/v1\/presentation-sessions\/([^/]+)\/report$/.exec(
      new URL(request.url).pathname,
    );
    const presentationSessionId = match?.[1];
    if (presentationSessionId === undefined) return null;
    const principal = await owners.resolve({ accountId, presentationSessionId });
    if (principal === null) return response({ error: "report_forbidden" }, 403);
    const state = await reports.readForOwner(principal);
    return state === null || state.finalizedAtMs === null
      ? response({ status: "pending" }, 202)
      : response({ state }, 200);
  };
}

/** Owner-rechecking private route for the typed, finalized report DTO. */
export function createFinalizedSessionReportReadRouteHandler(
  reports: FinalizedSessionReportReader,
  owners: SessionReportOwnerResolver,
  preparedEvidence: PreparedEvidenceReportSnapshotResolver,
): SessionReportReadRouteHandler {
  return async (request, accountId) => {
    if (request.method !== "GET") return null;
    const match = /^\/v1\/presentation-sessions\/([^/]+)\/report$/.exec(
      new URL(request.url).pathname,
    );
    const presentationSessionId = match?.[1];
    if (presentationSessionId === undefined) return null;
    const principal = await owners.resolve({ accountId, presentationSessionId });
    if (principal === null) return response({ error: "report_forbidden" }, 403);
    const snapshot = await preparedEvidence.resolve(principal);
    const report = await reports.readFinalizedReport(principal, snapshot);
    return report === null ? response({ status: "pending" }, 202) : response({ report }, 200);
  };
}

/** Combined route: session-end persists derived state before returning 202; GET remains owner-only. */
export function createSessionReportRouteHandler(
  reports: SessionReportEnder,
  owners: SessionReportOwnerResolver,
  preparedEvidence: PreparedEvidenceReportSnapshotResolver,
  endContext: SessionReportEndContextResolver,
  // Optional so routes wired without the prepared-evidence coordinator keep their exact behavior.
  endLifecycle?: SessionPresentationEndLifecycle,
): SessionReportReadRouteHandler {
  const read = createFinalizedSessionReportReadRouteHandler(reports, owners, preparedEvidence);
  return async (request, accountId, accountSessionId) => {
    const pathname = new URL(request.url).pathname;
    const endMatch = /^\/v1\/presentation-sessions\/([^/]+)\/end$/.exec(pathname);
    const presentationSessionId = endMatch?.[1];
    if (request.method !== "POST" || presentationSessionId === undefined) {
      return await read(request, accountId);
    }
    const principal = await owners.resolve({ accountId, presentationSessionId });
    if (principal === null) return response({ error: "report_forbidden" }, 403);
    if (endLifecycle !== undefined && accountSessionId !== undefined) {
      const outcome = await endLifecycle({ accountSessionId, presentationSessionId });
      // The owner retrying an already-ended presentation keeps the idempotent 202 contract;
      // every other coordinator rejection is surfaced as the existing unresolved-end conflict.
      const acceptedByOwnerRetry =
        outcome.outcome === "REJECTED" &&
        outcome.reason === "PRESENTATION_ENDED" &&
        "endedBySameOwner" in outcome &&
        outcome.endedBySameOwner === true;
      if (outcome.outcome !== "APPLIED" && !acceptedByOwnerRetry) {
        return response({ error: "presentation_end_conflict" }, 409);
      }
    }
    const context = await endContext.resolve(principal);
    if (context === null) return response({ error: "presentation_end_conflict" }, 409);
    await reports.endSession({ principal, ...context });
    return response({ status: "accepted" }, 202);
  };
}

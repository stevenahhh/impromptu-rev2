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
) => Promise<Response | null>;

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
): SessionReportReadRouteHandler {
  const read = createFinalizedSessionReportReadRouteHandler(reports, owners, preparedEvidence);
  return async (request, accountId) => {
    const pathname = new URL(request.url).pathname;
    const endMatch = /^\/v1\/presentation-sessions\/([^/]+)\/end$/.exec(pathname);
    const presentationSessionId = endMatch?.[1];
    if (request.method !== "POST" || presentationSessionId === undefined) {
      return await read(request, accountId);
    }
    const principal = await owners.resolve({ accountId, presentationSessionId });
    if (principal === null) return response({ error: "report_forbidden" }, 403);
    const context = await endContext.resolve(principal);
    if (context === null) return response({ error: "presentation_end_conflict" }, 409);
    await reports.endSession({ principal, ...context });
    return response({ status: "accepted" }, 202);
  };
}

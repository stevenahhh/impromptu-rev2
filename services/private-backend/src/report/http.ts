import type {
  SessionReportPrincipal,
  SessionReportRepository,
} from "./postgres-session-report-repository.ts";

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
    return state === null ? response({ status: "pending" }, 202) : response({ state }, 200);
  };
}

import {
  PresentationDetailResponseSchema,
  PresentationListResponseSchema,
  PresentationRenameRequestSchema,
  PresentationRenameResponseSchema,
} from "@impromptu/contracts/private";
import { isRecord, requestBody } from "../request-bodies.ts";
import { json } from "../responses.ts";
import type { AuthedRouteContext } from "../route-context.ts";

/**
 * Owner-scoped presentation library routes (GAP-10): list, resume detail, and rename.
 *
 * Registered in handler.ts's authenticated section: the account-session cookie gate upstream
 * authenticates every route here and non-GET mutations already carry the synchronizer CSRF.
 * Ownership itself is re-checked by the coordinator on every call — including GET — so these
 * routes never widen the authorization the rest of the control plane relies on.
 */

const PRESENTATION_PATH = /^\/v1\/presentations\/([^/]+)$/;
const MAX_PAGE_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 50;

function libraryRejection(reason: string, origin: Headers): Response {
  if (reason === "PRESENTATION_NOT_FOUND") {
    return json({ error: "presentation_not_found" }, 404, origin);
  }
  if (reason === "UNAUTHORIZED") return json({ error: "unauthorized" }, 403, origin);
  if (reason === "INVALID_CURSOR" || reason === "INVALID_PRESENTATION_TITLE") {
    return json({ error: "invalid_request" }, 400, origin);
  }
  return json({ error: "account_session_invalid" }, 401, origin);
}

/** Authenticated presentation-library routes. Returns null when no route matched. */
export async function presentationRoutes(ctx: AuthedRouteContext): Promise<Response | null> {
  const { request, url, origin, dependencies, accountSessionId } = ctx;

  if (request.method === "GET" && url.pathname === "/v1/presentations") {
    let limit = DEFAULT_PAGE_LIMIT;
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null) {
      if (!/^\d+$/.test(rawLimit)) return json({ error: "invalid_request" }, 400, origin);
      limit = Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
        return json({ error: "invalid_request" }, 400, origin);
      }
    }
    const cursorParam = url.searchParams.get("cursor");
    const result = await dependencies.coordinator.listPresentations(
      accountSessionId,
      {
        limit,
        ...(cursorParam === null ? {} : { cursor: cursorParam }),
      },
      dependencies.now(),
    );
    if (result.outcome === "REJECTED") return libraryRejection(result.reason, origin);
    return json(PresentationListResponseSchema.parse(result.value), 200, origin);
  }

  const detailMatch = PRESENTATION_PATH.exec(url.pathname);
  if (detailMatch === null) return null;
  const presentationSessionId = detailMatch[1] ?? "";

  if (request.method === "GET") {
    const result = await dependencies.coordinator.readPresentation(
      accountSessionId,
      presentationSessionId,
      dependencies.now(),
    );
    if (result.outcome === "REJECTED") return libraryRejection(result.reason, origin);
    return json(PresentationDetailResponseSchema.parse(result.value), 200, origin);
  }

  if (request.method === "POST") {
    const body = await requestBody(request);
    if (!isRecord(body)) return json({ error: "invalid_request" }, 400, origin);
    // The closed DTO owns validation — including unknown keys — and the coordinator still
    // re-parses so ownership and shape cannot drift apart between boundary and store.
    const rename = PresentationRenameRequestSchema.safeParse(body);
    if (!rename.success) return json({ error: "invalid_request" }, 400, origin);
    const result = await dependencies.coordinator.renamePresentation(
      accountSessionId,
      presentationSessionId,
      rename.data,
      dependencies.now(),
    );
    if (result.outcome === "REJECTED") return libraryRejection(result.reason, origin);
    await dependencies.persist?.();
    return json(
      PresentationRenameResponseSchema.parse({ presentation: result.value }),
      200,
      origin,
    );
  }

  // Owner-scoped delete: same cookie + CSRF boundary as rename; the coordinator re-checks
  // ownership and drops the whole record. The response carries only an acknowledgement —
  // nothing about the removed deck needs to come back over the wire.
  if (request.method === "DELETE") {
    const result = await dependencies.coordinator.deletePresentation(
      accountSessionId,
      presentationSessionId,
      dependencies.now(),
    );
    if (result.outcome === "REJECTED") return libraryRejection(result.reason, origin);
    await dependencies.persist?.();
    return json({ deleted: true }, 200, origin);
  }

  return json({ error: "not_found" }, 404, origin);
}

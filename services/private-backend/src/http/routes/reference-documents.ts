import {
  ReferenceDocumentListResponseSchema,
  ReferenceDocumentUploadOutcomeSchema,
} from "@impromptu/contracts/private";
import { boundedReferenceUploadForm, isMultipartFormData } from "../request-bodies.ts";
import { json, referenceUploadRejection } from "../responses.ts";
import type { AuthedRouteContext } from "../route-context.ts";
import type { RawReferenceDocument } from "../types.ts";

/** Authenticated reference-document routes. Returns null when no route matched. */
export async function referenceDocumentRoutes(ctx: AuthedRouteContext): Promise<Response | null> {
  const { request, url, origin, dependencies } = ctx;

  if (request.method === "POST" && url.pathname === "/v1/reference-documents") {
    if (dependencies.referenceDocuments === undefined) {
      return json({ error: "reference_documents_unavailable" }, 503, origin);
    }
    if (!isMultipartFormData(request.headers.get("content-type"))) {
      return json({ error: "unsupported_content_type" }, 400, origin);
    }
    const form = await boundedReferenceUploadForm(request);
    if (form.outcome === "REJECTED") {
      return referenceUploadRejection({ outcome: "REJECTED", reason: form.reason }, origin);
    }
    const presentationSessionId = form.form.get("presentationSessionId");
    if (typeof presentationSessionId !== "string" || presentationSessionId.length === 0) {
      return json({ error: "presentation_session_required" }, 400, origin);
    }
    const documents: RawReferenceDocument[] = [];
    for (const entry of form.form.getAll("files")) {
      if (!(entry instanceof File)) continue;
      documents.push({
        filename: entry.name,
        contentType: entry.type,
        bytes: new Uint8Array(await entry.arrayBuffer()),
      });
    }
    const outcome = await dependencies.referenceDocuments.acceptReferenceDocuments({
      accountId: ctx.accountId,
      actorId: ctx.actorId,
      presentationSessionId,
      documents,
    });
    return outcome.outcome === "ACCEPTED"
      ? json(ReferenceDocumentUploadOutcomeSchema.parse(outcome), 201, origin)
      : referenceUploadRejection(outcome, origin);
  }

  if (request.method === "GET" && url.pathname === "/v1/reference-documents") {
    if (dependencies.referenceDocuments === undefined) {
      return json({ error: "reference_documents_unavailable" }, 503, origin);
    }
    const presentationSessionId = url.searchParams.get("presentationSessionId");
    if (presentationSessionId === null || presentationSessionId.length === 0) {
      return json({ error: "presentation_session_required" }, 400, origin);
    }
    const documents = await dependencies.referenceDocuments.listReferenceDocuments({
      accountId: ctx.accountId,
      presentationSessionId,
    });
    return json(ReferenceDocumentListResponseSchema.parse({ documents }), 200, origin);
  }

  return null;
}

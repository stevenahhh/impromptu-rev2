// Presenter-uploaded reference documents: closed receipt/list parsing and the
// multipart upload and listing calls.

import { type PrivateClientContext, responseBody } from "./private-transport";

/** One presenter-uploaded reference document, as summarized by the private backend. */
export interface ReferenceDocumentSummaryView {
  readonly documentId: string;
  readonly presentationSessionId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly chunkCount: number;
  readonly status: "INDEXED" | "STORED_INDEX_PENDING" | "EMPTY";
}

export type ReferenceDocumentUploadView =
  | { readonly outcome: "ACCEPTED"; readonly documents: readonly ReferenceDocumentSummaryView[] }
  | { readonly outcome: "REJECTED"; readonly reason: string };

function referenceDocumentSummary(value: unknown): ReferenceDocumentSummaryView | null {
  if (typeof value !== "object" || value === null) return null;
  const documentId = Reflect.get(value, "documentId");
  const presentationSessionId = Reflect.get(value, "presentationSessionId");
  const filename = Reflect.get(value, "filename");
  const contentType = Reflect.get(value, "contentType");
  const byteLength = Reflect.get(value, "byteLength");
  const chunkCount = Reflect.get(value, "chunkCount");
  const status = Reflect.get(value, "status");
  if (
    typeof documentId !== "string" ||
    typeof presentationSessionId !== "string" ||
    typeof filename !== "string" ||
    typeof contentType !== "string" ||
    typeof byteLength !== "number" ||
    typeof chunkCount !== "number" ||
    (status !== "INDEXED" && status !== "STORED_INDEX_PENDING" && status !== "EMPTY")
  ) {
    return null;
  }
  return {
    documentId,
    presentationSessionId,
    filename,
    contentType,
    byteLength,
    chunkCount,
    status,
  };
}

function referenceDocumentUploadView(value: unknown): ReferenceDocumentUploadView | null {
  if (typeof value !== "object" || value === null) return null;
  const outcome = Reflect.get(value, "outcome");
  if (outcome === "REJECTED") {
    const reason = Reflect.get(value, "reason");
    return typeof reason === "string" ? { outcome: "REJECTED", reason } : null;
  }
  if (outcome !== "ACCEPTED") return null;
  const documents = Reflect.get(value, "documents");
  if (!Array.isArray(documents)) return null;
  const parsed = documents.flatMap((entry) => {
    const summary = referenceDocumentSummary(entry);
    return summary === null ? [] : [summary];
  });
  return parsed.length === documents.length ? { outcome: "ACCEPTED", documents: parsed } : null;
}

export async function uploadReferenceDocuments(
  context: PrivateClientContext,
  csrfToken: string,
  presentationSessionId: string,
  files: readonly File[],
): Promise<ReferenceDocumentUploadView> {
  const form = new FormData();
  form.set("presentationSessionId", presentationSessionId);
  for (const file of files) form.append("files", file, file.name);
  const response = await fetch(`${context.baseUrl}/v1/reference-documents`, {
    method: "POST",
    credentials: "include",
    // FormData sets its own multipart boundary, so the CSRF header travels alone here.
    headers: { "x-csrf-token": csrfToken },
    body: form,
  });
  const view = referenceDocumentUploadView(await responseBody(response));
  if (view === null) throw new Error("The reference-document upload receipt was unreadable.");
  return view;
}

export async function listReferenceDocuments(
  context: PrivateClientContext,
  presentationSessionId: string,
): Promise<readonly ReferenceDocumentSummaryView[]> {
  const response = await fetch(
    `${context.baseUrl}/v1/reference-documents?presentationSessionId=${encodeURIComponent(presentationSessionId)}`,
    { credentials: "include" },
  );
  const body = await responseBody(response);
  const documents =
    typeof body === "object" && body !== null ? Reflect.get(body, "documents") : null;
  if (!response.ok || !Array.isArray(documents)) {
    throw new Error("The reference-document list could not be read.");
  }
  return documents.flatMap((entry) => {
    const summary = referenceDocumentSummary(entry);
    return summary === null ? [] : [summary];
  });
}

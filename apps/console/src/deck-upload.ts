// Multipart deck upload over credentialed XHR: MIME gating, upload progress,
// abort plumbing, and the closed parsing of the typed 201 receipt and backend
// rejection payloads.

import type { PrivateClientContext } from "./private-transport";

export const DECK_UPLOAD_MIME_TYPES = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
} as const;

export type DeckUploadMimeType =
  (typeof DECK_UPLOAD_MIME_TYPES)[keyof typeof DECK_UPLOAD_MIME_TYPES];

const DECK_UPLOAD_REJECTION_STATUS = {
  empty_input: 400,
  unsupported_extension: 400,
  malformed_input: 400,
  input_too_large: 413,
  unsafe_filename: 400,
  size_mismatch: 400,
} as const;

type DeckUploadRejectionCode = keyof typeof DECK_UPLOAD_REJECTION_STATUS;

export interface DeckUploadView {
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly deckVersion: string;
  readonly sourceHash?: string;
  readonly privateDeck?: unknown;
  readonly publicDeck?: unknown;
}

export interface DeckUploadProgress {
  readonly loadedBytes: number;
  readonly totalBytes: number;
}

export interface DeckUploadProgressEvent {
  readonly lengthComputable?: boolean;
  readonly loaded?: number;
  readonly total?: number;
}

/** Minimal transport surface of XMLHttpRequest used by the multipart deck upload. */
export interface DeckUploadXhr {
  withCredentials: boolean;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: unknown): void;
  abort(): void;
  readonly upload: { onprogress: ((event: DeckUploadProgressEvent) => void) | null };
  onload: ((event: DeckUploadProgressEvent) => void) | null;
  onerror: ((event: DeckUploadProgressEvent) => void) | null;
  onabort: ((event: DeckUploadProgressEvent) => void) | null;
  ontimeout: ((event: DeckUploadProgressEvent) => void) | null;
  status: number;
  responseText: string;
}

export interface UploadDeckOptions {
  readonly transport?: DeckUploadXhr;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DeckUploadProgress) => void;
}

export class DeckUploadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, options: { readonly status: number; readonly cause?: unknown }) {
    if (options.cause === undefined) {
      super(code);
    } else {
      super(code, { cause: options.cause });
    }
    this.name = "DeckUploadError";
    this.code = code;
    this.status = options.status;
  }
}

function createAbortError(): Error {
  return new DOMException("Deck upload was aborted.", "AbortError");
}

function deckUploadContentType(file: File): DeckUploadMimeType | null {
  if (file.type === DECK_UPLOAD_MIME_TYPES.pptx) return DECK_UPLOAD_MIME_TYPES.pptx;
  if (file.type === DECK_UPLOAD_MIME_TYPES.pdf) return DECK_UPLOAD_MIME_TYPES.pdf;
  return null;
}

function parseDeckUploadView(text: string, status: number): DeckUploadView {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (cause) {
    throw new DeckUploadError("invalid_upload_receipt", { status, cause });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DeckUploadError("invalid_upload_receipt", { status });
  }
  const candidate = body as Record<string, unknown>;
  const { presentationSessionId, presentationSessionEpoch, deckVersion } = candidate;
  if (
    typeof presentationSessionId !== "string" ||
    presentationSessionId.length === 0 ||
    typeof presentationSessionEpoch !== "string" ||
    presentationSessionEpoch.length === 0 ||
    typeof deckVersion !== "string" ||
    deckVersion.length === 0
  ) {
    throw new DeckUploadError("invalid_upload_receipt", { status });
  }
  return {
    presentationSessionId,
    presentationSessionEpoch,
    deckVersion,
    ...(typeof candidate.sourceHash === "string" ? { sourceHash: candidate.sourceHash } : {}),
    ...(candidate.privateDeck !== undefined ? { privateDeck: candidate.privateDeck } : {}),
    ...(candidate.publicDeck !== undefined ? { publicDeck: candidate.publicDeck } : {}),
  };
}

function decodeBackendError(text: string, status: number): DeckUploadError {
  let code = status === 0 ? "network_error" : "upload_rejected";
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null) {
      const payload = body as Record<string, unknown>;
      const reported = payload.error;
      const rejectionCode = payload.code;
      if (
        reported === "deck_upload_rejected" &&
        typeof rejectionCode === "string" &&
        DECK_UPLOAD_REJECTION_STATUS[rejectionCode as DeckUploadRejectionCode] === status
      ) {
        code = rejectionCode;
      } else if (typeof reported === "string" && reported.length > 0) {
        code = reported;
      }
    }
  } catch {
    // The body is not a JSON backend error payload; keep the fallback code.
  }
  return new DeckUploadError(code, { status });
}

export function uploadDeck(
  context: PrivateClientContext,
  csrfToken: string,
  file: File,
  options: UploadDeckOptions = {},
): Promise<DeckUploadView> {
  const contentType = deckUploadContentType(file);
  if (contentType === null || typeof file.name !== "string" || file.name.length === 0) {
    return Promise.reject(new DeckUploadError("unsupported_deck_file", { status: 0 }));
  }
  const signal = options.signal;
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  const transport = options.transport ?? new XMLHttpRequest();
  transport.withCredentials = true;
  const url = `${context.baseUrl}/v1/deck-uploads`;
  return new Promise<DeckUploadView>((resolve, reject) => {
    const abortError = createAbortError();
    let settled = false;
    const finish = (execute: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      transport.upload.onprogress = null;
      execute();
    };
    const complete = (view: DeckUploadView) => finish(() => resolve(view));
    const rejectWith = (error: Error) => finish(() => reject(error));
    const onAbort = () => {
      transport.abort();
      rejectWith(abortError);
    };
    transport.onabort = () => rejectWith(abortError);
    transport.onerror = () => rejectWith(new DeckUploadError("network_error", { status: 0 }));
    transport.ontimeout = () => rejectWith(new DeckUploadError("upload_timeout", { status: 0 }));
    transport.onload = () => {
      if (transport.status !== 201) {
        rejectWith(decodeBackendError(transport.responseText, transport.status));
        return;
      }
      try {
        complete(parseDeckUploadView(transport.responseText, transport.status));
      } catch (cause) {
        rejectWith(
          cause instanceof DeckUploadError
            ? cause
            : new DeckUploadError("invalid_upload_receipt", {
                status: transport.status,
                cause,
              }),
        );
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    transport.open("POST", url);
    transport.setRequestHeader("x-csrf-token", csrfToken);
    transport.upload.onprogress = (event: DeckUploadProgressEvent) => {
      options.onProgress?.({
        loadedBytes: typeof event.loaded === "number" ? event.loaded : 0,
        totalBytes: typeof event.total === "number" && event.total > 0 ? event.total : file.size,
      });
    };
    const form = new FormData();
    form.append("file", file);
    transport.send(form);
  });
}

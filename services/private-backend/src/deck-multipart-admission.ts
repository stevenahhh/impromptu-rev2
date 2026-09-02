/**
 * Multipart part admission rules for deck uploads: which multipart parts are
 * accepted, and which header/filename/MIME combinations map to a deck content
 * type. These run before any body byte is consumed by the caller.
 *
 * Trust boundary: filenames arrive user-controlled, so every check here is
 * load-bearing.
 */

import { DeckUploadRejectedError } from "./deck-upload-service.ts";
import type { DeckUploadContentType } from "./http.ts";

export const FILE_FIELD_NAME = "file";
const MAX_FILENAME_BYTES = 255;

const DECK_EXTENSION_BY_MIME: Readonly<Record<DeckUploadContentType, string>> = {
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/pdf": ".pdf",
};

function rejected(code: DeckUploadRejectedError["code"], message: string): DeckUploadRejectedError {
  return new DeckUploadRejectedError(code, message);
}

/**
 * Validates the declared Content-Length framing without capping it: an absent
 * header is fine (chunked upload), while a non-numeric or out-of-range value
 * is malformed framing and rejects.
 */
export function declaredBodyLength(request: Request): number | null {
  const header = request.headers.get("content-length");
  if (header === null) return null;
  if (!/^\d+$/.test(header)) {
    throw rejected("malformed_input", "Invalid multipart Content-Length");
  }
  const value = Number(header);
  if (!Number.isSafeInteger(value)) {
    throw rejected("input_too_large", "Multipart upload length exceeds the supported range");
  }
  return value;
}

export function fileMetadata(
  fieldName: string,
  filename: string,
  transferEncoding: string,
  mimeType: string,
): { readonly filename: string; readonly contentType: DeckUploadContentType } {
  if (fieldName !== FILE_FIELD_NAME) {
    throw rejected("malformed_input", `Unexpected multipart field: ${fieldName}`);
  }
  if (
    filename.length === 0 ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    new TextEncoder().encode(filename).byteLength > MAX_FILENAME_BYTES
  ) {
    throw rejected("unsafe_filename", "Unsafe multipart filename");
  }
  if (transferEncoding !== "7bit" && transferEncoding !== "binary") {
    throw rejected("malformed_input", "Unsupported multipart transfer encoding");
  }

  const extension = DECK_EXTENSION_BY_MIME[mimeType as DeckUploadContentType];
  const lowerFilename = filename.toLowerCase();
  if (extension === undefined) {
    throw rejected("malformed_input", `Unsupported deck MIME type: ${mimeType}`);
  }
  if (!lowerFilename.endsWith(extension)) {
    const hasSupportedExtension = Object.values(DECK_EXTENSION_BY_MIME).some((candidate) =>
      lowerFilename.endsWith(candidate),
    );
    throw rejected(
      hasSupportedExtension ? "malformed_input" : "unsupported_extension",
      "Deck filename does not match its MIME type",
    );
  }
  return { filename, contentType: mimeType as DeckUploadContentType };
}

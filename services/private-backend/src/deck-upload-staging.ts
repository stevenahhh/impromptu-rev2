/**
 * Upload validation and streaming ingestion.
 *
 * Filename, extension, empty, and declared-size checks run before the first
 * body byte is read; signature validation uses only a bounded prefix captured
 * while streaming, so a bad signature rejects without writing body bytes.
 * Actual/declaration mismatch and empty bodies reject without invoking the
 * renderer. Deck size itself is not capped: chunks go straight to disk, never
 * through memory.
 */

import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import type { DeckUploadInput, DeckUploadRejectionCode } from "./deck-upload-contract.ts";

const ZIP_LOCAL_FILE_HEADER = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const PDF_HEADER = new TextEncoder().encode("%PDF-");

export const SIGNATURES: ReadonlyArray<readonly [extension: string, signature: Uint8Array]> = [
  [".pptx", ZIP_LOCAL_FILE_HEADER],
  [".pdf", PDF_HEADER],
];

const MAX_SIGNATURE_PREFIX_BYTES = Math.max(
  ...SIGNATURES.map(([, signature]) => signature.byteLength),
);

export interface Rejection {
  readonly code: DeckUploadRejectionCode;
  readonly message: string;
}

export function rejection(code: DeckUploadRejectionCode, message: string): Rejection {
  return { code, message };
}

function hasPrefix(content: Uint8Array, prefix: Uint8Array): boolean {
  if (content.byteLength < prefix.byteLength) return false;
  for (let i = 0; i < prefix.byteLength; i++) {
    if (content[i] !== prefix[i]) return false;
  }
  return true;
}

function isUnsafeFileName(fileName: string): boolean {
  return (
    fileName.length === 0 ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\")
  );
}

/** Checks that need no body bytes: declaration and file name only. */
export function validateDeclaration(input: DeckUploadInput): Rejection | null {
  const { fileName, byteLength } = input;

  if (byteLength === 0) {
    return rejection("empty_input", "Upload is empty");
  }
  if (isUnsafeFileName(fileName)) {
    return rejection("unsafe_filename", `Unsafe file name: ${JSON.stringify(fileName)}`);
  }

  const lowerName = fileName.toLowerCase();
  if (!SIGNATURES.some(([extension]) => lowerName.endsWith(extension))) {
    return rejection(
      "unsupported_extension",
      `Unsupported file extension: ${JSON.stringify(fileName)}`,
    );
  }
  return null;
}

/** Signature check against the bounded prefix captured while streaming. */
function validateSignature(fileName: string, prefix: Uint8Array): Rejection | null {
  const lowerName = fileName.toLowerCase();
  for (const [extension, signature] of SIGNATURES) {
    if (lowerName.endsWith(extension)) {
      if (!hasPrefix(prefix, signature)) {
        return rejection("malformed_input", `Content does not match the ${extension} signature`);
      }
      return null;
    }
  }
  return rejection(
    "unsupported_extension",
    `Unsupported file extension: ${JSON.stringify(fileName)}`,
  );
}

/**
 * Stream the body to `fd` while hashing and counting it. Only the bounded
 * signature prefix is retained in memory; every chunk is written to disk as it
 * arrives. Returns a rejection when the body is malformed or disagrees with
 * the declared byteLength.
 */
export async function streamUploadToFile(
  input: DeckUploadInput,
  fd: number,
): Promise<Rejection | null> {
  const { fileName, byteLength: declared, content } = input;

  const reader = content.getReader();
  const hash = createHash("sha256");
  const prefix = new Uint8Array(MAX_SIGNATURE_PREFIX_BYTES);
  let prefixBytes = 0;
  let counted = 0;
  let signatureChecked = false;

  const cancelSource = async (): Promise<void> => {
    try {
      await reader.cancel();
    } catch {
      // The source already failed or refuses cancellation; the upload is rejected regardless.
    }
  };

  try {
    while (true) {
      let chunk: Uint8Array;
      try {
        const read = await reader.read();
        if (read.done) break;
        chunk = read.value;
      } catch (error) {
        await cancelSource();
        return rejection(
          "malformed_input",
          `Upload body could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (chunk.byteLength === 0) continue;

      // Capture the bounded prefix before the chunk that completes it hits disk,
      // so a bad signature is rejected without writing body bytes.
      const take = Math.min(MAX_SIGNATURE_PREFIX_BYTES - prefixBytes, chunk.byteLength);
      prefix.set(chunk.subarray(0, take), prefixBytes);
      prefixBytes += take;
      if (!signatureChecked && prefixBytes >= MAX_SIGNATURE_PREFIX_BYTES) {
        signatureChecked = true;
        const signatureRejection = validateSignature(fileName, prefix);
        if (signatureRejection !== null) {
          await cancelSource();
          return signatureRejection;
        }
      }

      counted += chunk.byteLength;
      writeSync(fd, chunk);
      hash.update(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (declared !== undefined && counted !== declared) {
    return rejection(
      "size_mismatch",
      `Upload declared ${declared} bytes but the body contained ${counted}`,
    );
  }
  if (counted === 0) {
    return rejection("empty_input", "Upload is empty");
  }
  // A body shorter than the signature never completed the prefix; validate the
  // short prefix directly so it rejects as malformed rather than passing.
  if (!signatureChecked) {
    return validateSignature(fileName, prefix.subarray(0, prefixBytes));
  }
  return null;
}

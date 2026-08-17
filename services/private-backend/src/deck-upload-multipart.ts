import { once } from "node:events";
import { Readable } from "node:stream";
import Busboy, { type BusboyFileStream, type BusboyInstance } from "@fastify/busboy";
import { DeckUploadRejectedError } from "./deck-upload-service.ts";
import { MAX_DECK_UPLOAD_BYTES } from "./deck-upload-worker.ts";
import type { DeckUploadContentType, RawDeckUpload } from "./http.ts";

const FILE_FIELD_NAME = "file";
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_MULTIPART_BODY_BYTES = MAX_DECK_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES;
const MAX_CONTENT_TYPE_HEADER_BYTES = 512;
const MAX_PART_HEADER_BYTES = 8 * 1024;
const MAX_FILENAME_BYTES = 255;

const DECK_EXTENSION_BY_MIME: Readonly<Record<DeckUploadContentType, string>> = {
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/pdf": ".pdf",
};

export interface ParsedDeckMultipart {
  readonly upload: RawDeckUpload;
  readonly finished: Promise<void>;
  cancel(reason?: unknown): Promise<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function rejected(code: DeckUploadRejectedError["code"], message: string): DeckUploadRejectedError {
  return new DeckUploadRejectedError(code, message);
}

function malformed(error: unknown): DeckUploadRejectedError {
  return error instanceof DeckUploadRejectedError
    ? error
    : rejected(
        "malformed_input",
        error instanceof Error ? error.message : "Malformed multipart upload",
      );
}

function declaredBodyLength(request: Request): number | null {
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

function fileMetadata(
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

function fileBody(
  file: BusboyFileStream,
  finished: Promise<void>,
  cancelUpload: (reason?: unknown) => Promise<void>,
): ReadableStream<Uint8Array> {
  const body = Readable.toWeb(file) as unknown as ReadableStream<Uint8Array>;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await finished;
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await cancelUpload(reason);
      }
    },
  });
}

/**
 * Opens exactly one bounded multipart file part without materializing the request body.
 * The returned stream does not reach EOF until Busboy has validated the closing boundary
 * and confirmed that no second part exists.
 */
export async function parseDeckUploadMultipart(request: Request): Promise<ParsedDeckMultipart> {
  const contentType = request.headers.get("content-type");
  if (
    contentType === null ||
    contentType.length > MAX_CONTENT_TYPE_HEADER_BYTES ||
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "multipart/form-data"
  ) {
    throw rejected("malformed_input", "Expected multipart/form-data");
  }
  const contentLength = declaredBodyLength(request);
  if (contentLength !== null && contentLength > MAX_MULTIPART_BODY_BYTES) {
    throw rejected("input_too_large", "Multipart upload exceeds the request limit");
  }
  if (request.body === null) {
    throw rejected("malformed_input", "Multipart body is required");
  }

  let parser: BusboyInstance;
  try {
    parser = new Busboy({
      headers: { "content-type": contentType },
      preservePath: true,
      fileHwm: 64 * 1024,
      isPartAFile(fieldName, partContentType, filename) {
        return (
          fieldName === FILE_FIELD_NAME ||
          filename !== undefined ||
          partContentType === "application/pdf" ||
          partContentType ===
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        );
      },
      limits: {
        fieldNameSize: 32,
        fieldSize: 0,
        fields: 0,
        fileSize: MAX_DECK_UPLOAD_BYTES + 1,
        files: 1,
        parts: 1,
        headerPairs: 4,
        headerSize: MAX_PART_HEADER_BYTES,
      },
    });
  } catch (error) {
    throw malformed(error);
  }

  const source = request.body.getReader();
  const part = deferred<RawDeckUpload>();
  const completion = deferred<void>();
  // The consumer awaits this after the file stream ends. Attaching a rejection
  // handler now prevents a parser failure from becoming transiently unhandled.
  void completion.promise.catch(() => undefined);
  void part.promise.catch(() => undefined);

  let file: BusboyFileStream | null = null;
  let fileCount = 0;
  let settled = false;
  let canceled = false;

  const fail = (error: unknown): DeckUploadRejectedError => {
    const rejection = malformed(error);
    if (!settled) {
      settled = true;
      part.reject(rejection);
      completion.reject(rejection);
    }
    return rejection;
  };

  const cancel = async (reason?: unknown): Promise<void> => {
    if (canceled) return;
    canceled = true;
    const error = fail(reason ?? rejected("malformed_input", "Multipart upload was canceled"));
    if (file !== null && !file.destroyed) file.destroy();
    if (!parser.destroyed) parser.destroy();
    try {
      await source.cancel(error);
    } catch {
      // The body may already be closed; cancellation is still complete.
    }
  };

  parser.on("file", (fieldName, nextFile, filename, transferEncoding, mimeType) => {
    fileCount += 1;
    file = nextFile;
    let metadata: ReturnType<typeof fileMetadata>;
    try {
      metadata = fileMetadata(fieldName, filename, transferEncoding, mimeType);
    } catch (error) {
      nextFile.resume();
      const rejection = fail(error);
      void cancel(rejection);
      return;
    }
    nextFile.on("limit", () => {
      fail(rejected("input_too_large", "Multipart file part exceeds the upload limit"));
    });
    part.resolve({
      ...metadata,
      body: fileBody(nextFile, completion.promise, cancel),
    });
  });
  parser.on("field", () => {
    const rejection = fail(rejected("malformed_input", "Multipart text fields are not accepted"));
    void cancel(rejection);
  });
  parser.on("partsLimit", () => {
    const rejection = fail(rejected("malformed_input", "Exactly one multipart part is required"));
    void cancel(rejection);
  });
  parser.on("filesLimit", () => {
    const rejection = fail(rejected("malformed_input", "Exactly one multipart file is required"));
    void cancel(rejection);
  });
  parser.on("fieldsLimit", () => {
    const rejection = fail(rejected("malformed_input", "Multipart text fields are not accepted"));
    void cancel(rejection);
  });
  parser.on("error", (error) => {
    fail(error);
  });
  parser.on("finish", () => {
    if (settled) return;
    if (fileCount !== 1) {
      fail(rejected("malformed_input", "Exactly one multipart file is required"));
      return;
    }
    settled = true;
    completion.resolve();
  });

  const pump = async (): Promise<void> => {
    let totalBytes = 0;
    try {
      while (true) {
        const next = await source.read();
        if (next.done) {
          if (!parser.destroyed) parser.end();
          return;
        }
        totalBytes += next.value.byteLength;
        if (totalBytes > MAX_MULTIPART_BODY_BYTES) {
          throw rejected("input_too_large", "Multipart upload exceeds the request limit");
        }
        if (!parser.write(next.value)) await once(parser, "drain");
      }
    } catch (error) {
      const rejection = fail(error);
      if (file !== null && !file.destroyed) file.destroy();
      if (!parser.destroyed) parser.destroy();
      try {
        await source.cancel(rejection);
      } catch {
        // The body source failed first.
      }
    } finally {
      source.releaseLock();
    }
  };
  void pump();

  try {
    return { upload: await part.promise, finished: completion.promise, cancel };
  } catch (error) {
    await cancel(error);
    throw error;
  }
}

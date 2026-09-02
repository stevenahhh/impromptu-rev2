/**
 * Opens exactly one bounded multipart file part without materializing the
 * request body, bridging Busboy's Node streams into a web ReadableStream.
 *
 * The returned stream does not reach EOF until Busboy has validated the
 * closing boundary and confirmed that no second part exists. Every terminal
 * path destroys the parser/file stream and cancels the request body.
 */

import { once } from "node:events";
import { Readable } from "node:stream";
import Busboy, { type BusboyFileStream, type BusboyInstance } from "@fastify/busboy";
import { declaredBodyLength, FILE_FIELD_NAME, fileMetadata } from "./deck-multipart-admission.ts";
import { DeckUploadRejectedError } from "./deck-upload-service.ts";
import type { RawDeckUpload } from "./http.ts";

const MAX_CONTENT_TYPE_HEADER_BYTES = 512;
const MAX_PART_HEADER_BYTES = 8 * 1024;

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

export async function parseDeckUploadMultipart(request: Request): Promise<ParsedDeckMultipart> {
  const contentType = request.headers.get("content-type");
  if (
    contentType === null ||
    contentType.length > MAX_CONTENT_TYPE_HEADER_BYTES ||
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "multipart/form-data"
  ) {
    throw rejected("malformed_input", "Expected multipart/form-data");
  }
  // Read for its own sake: a Content-Length that is not a safe integer is malformed
  // framing and still rejects. Deck size itself is not capped.
  declaredBodyLength(request);
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
    try {
      while (true) {
        const next = await source.read();
        if (next.done) {
          if (!parser.destroyed) parser.end();
          return;
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

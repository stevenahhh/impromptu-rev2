/**
 * Shared contract for the deck upload pipeline: the worker's input/output
 * shapes, the renderer subprocess seam, and the worker error taxonomy.
 *
 * Contract: test/deck-upload-worker.test.ts.
 */

export type DeckUploadRejectionCode =
  | "empty_input"
  | "unsupported_extension"
  | "malformed_input"
  | "input_too_large"
  | "unsafe_filename"
  | "size_mismatch";

export interface DeckUploadInput {
  readonly fileName: string;
  /** Optional for multipart file parts, which do not carry their own Content-Length. */
  readonly byteLength?: number;
  readonly content: ReadableStream<Uint8Array>;
}

export type DeckUploadOutcome =
  | { readonly outcome: "RENDERED"; readonly artifactId: string; readonly manifest: unknown }
  | {
      readonly outcome: "REJECTED";
      readonly code: DeckUploadRejectionCode;
      readonly message: string;
    };

export interface RenderSubprocessRequest {
  readonly sourcePath: string; // staged upload file the renderer reads
  readonly outputDir: string; // renderer writes its output here
}

export type RenderSubprocessResult =
  | {
      readonly ok: true;
      readonly renderManifest: unknown;
      readonly ingestionManifest: unknown;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface RenderSubprocessAdapter {
  run(request: RenderSubprocessRequest, signal: AbortSignal): Promise<RenderSubprocessResult>;
}

export interface DeckUploadWorkerOptions {
  readonly subprocess: RenderSubprocessAdapter;
  readonly stagingRoot: string; // worker owns every file it creates under this directory
  readonly artifactRoot: string; // promoted artifacts live at artifactRoot/<artifactId>
  readonly deadlineMs?: number; // default render deadline; aborting the adapter signal enforces it
}

export class DeckUploadWorkerError extends Error {
  constructor(
    readonly code:
      | "render_failed"
      | "ocr_unavailable"
      | "deadline_exceeded"
      | "artifact_collision"
      | "artifact_path_rejected",
    message: string,
  ) {
    super(message);
    this.name = "DeckUploadWorkerError";
  }
}

export interface DeckUploadWorker {
  processUpload(input: DeckUploadInput): Promise<DeckUploadOutcome>;
}

/**
 * Authenticated deck upload service.
 *
 * Contract: test/deck-upload-service.test.ts.
 *
 * The single production path between the private HTTP boundary and the real
 * upload worker / render subprocess chain. `acceptRawDeck` consumes the raw
 * upload body strictly as a stream through createDeckUploadWorker (never
 * buffering or arrayBuffer-ing it), runs the staged file through
 * createDeckRenderSubprocess, and turns the worker's RENDERED artifactId and
 * strict render manifest into the private/public deck pair plus source hash
 * consumed by http.ts:
 *
 *   - publicBaseUrl is `${projectionGatewayOrigin}/v1/deck-assets/<artifactId>`
 *     (the immutable artifact directory the worker promoted),
 *   - the deck title is derived from the uploaded file name,
 *   - renderedDeckArtifacts closes the public artifact and private context.
 *
 * A REJECTED worker outcome (empty, malformed, unsafe, oversized, or
 * size-mismatched upload) throws a typed DeckUploadRejectedError without ever
 * invoking the renderer; the HTTP boundary returns its closed code without
 * exposing the diagnostic message or server paths.
 */
import type { AccountId } from "@impromptu/contracts/private";
import type { DeckUploadRejectionCode, DeckUploadWorker } from "./deck-upload-worker.ts";
import type { DeckUploadService } from "./http.ts";
import { renderedDeckArtifacts } from "./rendered-deck-artifacts.ts";

export class DeckUploadRejectedError extends Error {
  constructor(
    readonly code: DeckUploadRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "DeckUploadRejectedError";
  }
}

export interface DeckUploadServiceOptions {
  readonly worker: DeckUploadWorker;
  /** Exact public origin of the projection gateway that serves deck assets. */
  readonly projectionGatewayOrigin: string;
}

/** "quarterly-review.pptx" -> "Quarterly review"; "handout.pdf" -> "Handout". */
export function deckTitleFromFilename(filename: string): string {
  const extensionless = filename.replace(/\.[^.]*$/, "");
  const words = extensionless
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .join(" ");
  const title = words.charAt(0).toUpperCase() + words.slice(1);
  return title;
}

export function createDeckUploadService(options: DeckUploadServiceOptions): DeckUploadService {
  const { worker } = options;
  const baseUrl = options.projectionGatewayOrigin.replace(/\/+$/, "");

  return {
    async acceptRawDeck(input) {
      const outcome = await worker.processUpload({
        fileName: input.upload.filename,
        ...(input.upload.byteLength === undefined ? {} : { byteLength: input.upload.byteLength }),
        content: input.upload.body,
      });
      if (outcome.outcome === "REJECTED") {
        throw new DeckUploadRejectedError(outcome.code, outcome.message);
      }
      return renderedDeckArtifacts(input.accountId as AccountId, {
        title: deckTitleFromFilename(input.upload.filename),
        manifest: outcome.manifest,
        publicBaseUrl: `${baseUrl}/v1/deck-assets/${outcome.artifactId}`,
      });
    },
  };
}

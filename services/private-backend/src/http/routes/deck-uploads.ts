import type { ParsedDeckMultipart } from "../../deck-upload-multipart.ts";
import { parseDeckUploadMultipart } from "../../deck-upload-multipart.ts";
import { DeckUploadRejectedError } from "../../deck-upload-service.ts";
import { DeckUploadWorkerError } from "../../deck-upload-worker.ts";
import { isMultipartFormData } from "../request-bodies.ts";
import { deckUploadRejected, json } from "../responses.ts";
import type { AuthedRouteContext } from "../route-context.ts";
import type { DeckUploadAccepted, DeckUploadReceipt } from "../types.ts";

/** Authenticated deck upload route. Returns null when no route matched. */
export async function deckUploadRoutes(ctx: AuthedRouteContext): Promise<Response | null> {
  const { request, url, origin, dependencies, accountSessionId } = ctx;
  if (!(request.method === "POST" && url.pathname === "/v1/deck-uploads")) return null;

  if (dependencies.uploads === undefined) {
    return json({ error: "uploads_unavailable" }, 503, origin);
  }
  if (!isMultipartFormData(request.headers.get("content-type"))) {
    return json({ error: "unsupported_content_type" }, 400, origin);
  }
  let parsed: ParsedDeckMultipart | undefined;
  let receipt: DeckUploadReceipt;
  try {
    parsed = await parseDeckUploadMultipart(request);
    receipt = await dependencies.uploads.acceptRawDeck({
      accountId: ctx.accountId,
      actorId: ctx.actorId,
      upload: parsed.upload,
    });
    await parsed.finished;
  } catch (error) {
    let rejection = error;
    if (parsed !== undefined) {
      await parsed.cancel(error);
      try {
        await parsed.finished;
      } catch (parserError) {
        if (
          parserError instanceof DeckUploadRejectedError &&
          (!(rejection instanceof DeckUploadRejectedError) ||
            parserError.code === "input_too_large")
        ) {
          rejection = parserError;
        }
      }
    }
    if (rejection instanceof DeckUploadRejectedError) {
      return deckUploadRejected(rejection.code, origin);
    }
    if (rejection instanceof DeckUploadWorkerError && rejection.code === "ocr_unavailable") {
      return json({ error: "OCR_UNAVAILABLE" }, 422, origin);
    }
    return json({ error: "deck_upload_rejected" }, 400, origin);
  }
  const presentation = await dependencies.coordinator.createPresentation(
    accountSessionId,
    { privateDeck: receipt.privateDeck, publicDeck: receipt.publicDeck },
    dependencies.now(),
  );
  if (presentation.outcome === "REJECTED") {
    return json({ error: presentation.reason }, 400, origin);
  }
  await dependencies.persist?.();
  return json(
    {
      presentationSessionId: presentation.value.lifecycle.presentationSessionId,
      presentationSessionEpoch: presentation.value.lifecycle.presentationSessionEpoch,
      deckVersion: receipt.privateDeck.deckVersion,
      ...receipt,
    } satisfies DeckUploadAccepted,
    201,
    origin,
  );
}

import {
  MAX_QUESTION_CLIP_BYTES,
  MAX_QUESTION_CLIP_DURATION_MS,
  type SpokenQuestionTranscriptionOutcome,
} from "@impromptu/contracts/private";
import { boundedAudioHeader, readAudioFrame } from "../request-bodies.ts";
import { json } from "../responses.ts";
import type { AuthedRouteContext } from "../route-context.ts";

/**
 * Private one-shot transcription route for a spoken Q&A question clip (S5 sibling of
 * /v1/qa-defense). Registered in handler.ts's authenticated section, so the account-session
 * cookie and CSRF check already happened upstream; this module adds only shape/bound checks.
 *
 * DI mirrors `qaDefense`: `undefined` means this deployment runs without local STT, answered
 * with a typed STT_UNAVAILABLE outcome instead of a bare 503 so Console copy stays honest.
 *
 * HONEST-REJECTION RULE: every bounded-input refusal is an HTTP 200 carrying the uppercase
 * typed outcome union — an oversized or silent clip is a result, not a transport fault —
 * while anything that cannot produce a well-formed outcome at all still never fabricates
 * text. Bounds: MAX_QUESTION_CLIP_BYTES over the octet-stream body plus a declared duration
 * header capped at MAX_QUESTION_CLIP_DURATION_MS (an unprovable bound is refused as TOO_LONG).
 */

export const QUESTION_CLIP_TRANSCRIPTION_PATHNAME = "/v1/question-clips/transcription";

export interface SpokenQuestionRouteDependencies {
  readonly transcribe?: (
    identity: { readonly tenantId: string; readonly principalId: string },
    audio: Uint8Array,
  ) => Promise<SpokenQuestionTranscriptionOutcome>;
}

function rejection(reason: string, origin: Headers): Response {
  return json({ outcome: "REJECTED", reason }, 200, origin);
}

/** Returns null when no route matched so handler.ts can try the next group. */
export async function spokenQuestionRoutes(
  ctx: AuthedRouteContext,
  dependencies: SpokenQuestionRouteDependencies | undefined,
): Promise<Response | null> {
  const { request, url, origin, accountId, actorId } = ctx;
  if (request.method !== "POST" || url.pathname !== QUESTION_CLIP_TRANSCRIPTION_PATHNAME) {
    return null;
  }
  if (dependencies?.transcribe === undefined) {
    return rejection("STT_UNAVAILABLE", origin);
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("audio/webm")) {
    return rejection("UNSUPPORTED_CODEC", origin);
  }
  const durationMs = boundedAudioHeader(request, "x-audio-duration-ms", Number.MAX_SAFE_INTEGER);
  if (durationMs === null || durationMs > MAX_QUESTION_CLIP_DURATION_MS) {
    return rejection("TOO_LONG", origin);
  }
  const frame = await readAudioFrame(request);
  if (frame.outcome === "REJECTED") {
    return rejection(frame.reason === "FRAME_TOO_LARGE" ? "TOO_LARGE" : "EMPTY_AUDIO", origin);
  }
  if (frame.bytes.length > MAX_QUESTION_CLIP_BYTES) return rejection("TOO_LARGE", origin);
  const outcome = await dependencies.transcribe(
    { tenantId: accountId, principalId: actorId },
    frame.bytes,
  );
  return json(outcome, 200, origin);
}

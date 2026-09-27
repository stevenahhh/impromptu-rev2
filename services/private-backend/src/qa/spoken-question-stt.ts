import type {
  SpokenQuestionTranscriptionOutcome,
  SpokenQuestionTranscriptionRejection,
} from "@impromptu/contracts/private";
import type { ServerModelRouter } from "@impromptu/model-router";
import { createTrustedModelContext } from "@impromptu/model-router";
import { WHISPER_CPP_ADAPTER_ID } from "../model-adapters/stt-whisper-cpp.ts";

/**
 * One-shot transcription of a bounded spoken-question clip through the SAME pinned local
 * whisper.cpp adapter the continuous presenter capture uses (`ServerModelRouter.streamStt`).
 * There is deliberately no second STT runtime here: the clip is fed as a single chunk to the
 * streaming adapter and the FINAL transcripts are concatenated into one question text.
 */

export interface SpokenQuestionClipIdentity {
  readonly tenantId: string;
  readonly principalId: string;
}

export type SpokenQuestionStt = (
  identity: SpokenQuestionClipIdentity,
  audio: Uint8Array,
) => Promise<SpokenQuestionTranscriptionOutcome>;

function rejectionFor(modelErrorCode: string): SpokenQuestionTranscriptionRejection {
  // Environmental failures mean the capability itself cannot run right now; per-invocation
  // failures mean it ran and this clip failed. The distinction drives the Console copy.
  switch (modelErrorCode) {
    case "unsupported_capability":
    case "policy_denied":
    case "policy_version_mismatch":
    case "quota_exceeded":
    case "budget_exceeded":
    case "secret_unavailable":
      return "STT_UNAVAILABLE";
    default:
      return "TRANSCRIPTION_FAILED";
  }
}

export function createSpokenQuestionStt(options: {
  readonly router: ServerModelRouter;
  readonly adapterId?: string;
}): SpokenQuestionStt {
  const adapterId = options.adapterId ?? WHISPER_CPP_ADAPTER_ID;
  return async (identity, audio) => {
    const requestId = `question-clip:${crypto.randomUUID()}`;
    // The deadline is per request: a factory-scoped now() expires one minute after boot and
    // rejects every later clip as deadline_exceeded.
    const now = Date.now();
    const context = createTrustedModelContext({
      tenantId: identity.tenantId,
      principalId: identity.principalId,
      requestId,
      traceId: `${requestId}:${identity.tenantId}`,
      policyVersion: "model-policy-v1",
      deadlineAtMs: now + 60_000,
      signal: new AbortController().signal,
    });
    try {
      let text = "";
      let language: string | undefined;
      let durationMs = 0;
      // Copy into an ArrayBuffer-backed chunk so the generator matches SttAudioChunk exactly.
      const clipChunk = new Uint8Array(audio) as Uint8Array<ArrayBuffer>;
      for await (const item of options.router.streamStt(
        singleChunk(clipChunk),
        context,
        adapterId,
      )) {
        if (item.kind !== "transcript") {
          if (!item.result.ok) {
            return { outcome: "REJECTED", reason: rejectionFor(item.result.error.code) };
          }
          // Terminal success carries an aggregated transcript; only adopt it when the event
          // stream produced nothing (the whisper adapter normally emits FINAL events instead).
          if (text.length === 0) text = item.result.output.text;
          continue;
        }
        if (item.event.kind !== "FINAL") continue;
        text += item.event.transcript.text;
        language = item.event.transcript.language;
        durationMs += item.event.transcript.durationMs;
      }
      const trimmed = text.trim();
      if (trimmed.length === 0) return { outcome: "REJECTED", reason: "EMPTY_AUDIO" };
      if (language === undefined) return { outcome: "REJECTED", reason: "TRANSCRIPTION_FAILED" };
      return { outcome: "TRANSCRIBED", text: trimmed, language, durationMs };
    } catch {
      return { outcome: "REJECTED", reason: "TRANSCRIPTION_FAILED" };
    }
  };
}

async function* singleChunk(audio: Uint8Array<ArrayBuffer>) {
  yield { sequence: 0, audio };
}

import type { ServerModelRouter } from "@impromptu/model-router";
import { createTrustedModelContext } from "@impromptu/model-router";
import { createAudioIngestService } from "../audio-ingest.ts";
import { WHISPER_CPP_ADAPTER_ID } from "../model-adapters/stt-whisper-cpp.ts";
import type { PreparedEvidenceStore } from "../prepared-evidence.ts";
import type { SessionReportFinalizer } from "../report/session-report-finalizer.ts";
import type { PrivateRecommendationPipeline } from "../verifier/recommendation-pipeline.ts";
import type { WhisperCppPaths } from "./env.ts";

/**
 * Wires local audio capture when a whisper.cpp installation is pinned; otherwise returns
 * undefined so every /v1/audio route stays closed instead of refusing to boot.
 */
export function createAudio(options: {
  readonly whisperPaths: WhisperCppPaths | null;
  readonly modelRouter: ServerModelRouter;
  readonly store: PreparedEvidenceStore;
  readonly recommendations: PrivateRecommendationPipeline;
  readonly sessionReportFinalizer: SessionReportFinalizer;
}) {
  const { whisperPaths, modelRouter, store, recommendations, sessionReportFinalizer } = options;
  if (whisperPaths === null) return undefined;
  return createAudioIngestService({
    router: modelRouter,
    adapterId: WHISPER_CPP_ADAPTER_ID,
    createGrantId: () => `capture_${crypto.randomUUID()}`,
    coachingPreviewEnabledFor: () => true,
    recommendations: {
      resolveContext(identity) {
        const presentation = store.presentations.get(identity.presentationSessionId);
        if (
          presentation?.lifecycle.ownerAccountId !== identity.accountId ||
          presentation.lifecycle.presentationSessionEpoch !== identity.presentationSessionEpoch ||
          presentation.lifecycle.status !== "ACTIVE"
        ) {
          return null;
        }
        return {
          deckVersion: presentation.privateDeck.deckVersion,
          manifestHash: presentation.privateDeck.manifestHash,
        };
      },
      recommend(accountSessionId, input) {
        return recommendations.recommend(accountSessionId, input);
      },
    },
    onFinal(identity, event) {
      sessionReportFinalizer.recordFinal(
        {
          tenantId: identity.accountId,
          presentationSessionId: identity.presentationSessionId,
          ownerSubject: identity.accountId,
        },
        {
          finalSegmentId: event.finalSegmentId,
          transcript: event.transcript,
        },
      );
    },
    contextFor(identity, signal) {
      const startedAtMs = Date.now();
      const requestId = `audio-stt:${crypto.randomUUID()}`;
      return createTrustedModelContext({
        tenantId: identity.accountId,
        principalId: identity.actorId,
        requestId,
        traceId: `${requestId}:${identity.presentationSessionId}`,
        policyVersion: "model-policy-v1",
        deadlineAtMs: startedAtMs + 60_000,
        signal,
      });
    },
  });
}

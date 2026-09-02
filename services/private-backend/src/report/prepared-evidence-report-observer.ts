/**
 * Narrow adapter used by PreparedEvidenceCoordinator without adding report work to slide latency.
 * The finalizer is referenced as a type only so this module stays runtime-cycle-free.
 */
import type { PreparedEvidenceReportSnapshot } from "./session-report-dto.ts";
import type { SessionReportFinalizer } from "./session-report-finalizer.ts";

export function createPreparedEvidenceReportObserver(
  finalizer: SessionReportFinalizer,
  onFailure: (error: unknown) => void,
): Readonly<{
  onAcceptedSlideSet(input: {
    readonly tenantId: string;
    readonly presentationSessionId: string;
    readonly ownerSubject: string;
    readonly presentationSessionEpoch: number;
    readonly sequence: number;
    readonly publicSlideKey: string;
    readonly acceptedOffsetMs: number;
    readonly producerId: string;
  }): void;
  onPresentationEnded(input: {
    readonly tenantId: string;
    readonly presentationSessionId: string;
    readonly ownerSubject: string;
    readonly endedOffsetMs: number;
    readonly finalizedAtMs: number;
    readonly preparedEvidence: PreparedEvidenceReportSnapshot;
  }): Promise<void>;
  onFailure(error: unknown): void;
}> {
  return {
    onAcceptedSlideSet(input) {
      finalizer.recordAcceptedSlideSet({
        principal: {
          tenantId: input.tenantId,
          presentationSessionId: input.presentationSessionId,
          ownerSubject: input.ownerSubject,
        },
        presentationSessionEpoch: input.presentationSessionEpoch,
        sequence: input.sequence,
        publicSlideKey: input.publicSlideKey,
        acceptedOffsetMs: input.acceptedOffsetMs,
        producerId: input.producerId,
      });
    },
    async onPresentationEnded(input) {
      await finalizer.endSession({
        principal: {
          tenantId: input.tenantId,
          presentationSessionId: input.presentationSessionId,
          ownerSubject: input.ownerSubject,
        },
        endedOffsetMs: input.endedOffsetMs,
        finalizedAtMs: input.finalizedAtMs,
        preparedEvidence: input.preparedEvidence,
      });
    },
    onFailure,
  };
}

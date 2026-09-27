import type { PreparedEvidenceCoordinator, PreparedEvidenceStore } from "../prepared-evidence.ts";
import { createSessionReportRouteHandler } from "../report/http.ts";
import type { SessionReportFinalizer } from "../report/session-report-finalizer.ts";

/** Wires the authenticated session-report read routes against the shared prepared evidence. */
export function createSessionReportRead(options: {
  readonly store: PreparedEvidenceStore;
  readonly sessionReportFinalizer: SessionReportFinalizer;
  /** Optional; when absent the end route keeps its legacy coordinator-less behavior. */
  readonly coordinator?: PreparedEvidenceCoordinator;
  /** Clock shared by the end lifecycle and the end context; defaults to the wall clock. */
  readonly now?: () => number;
}) {
  const { store, sessionReportFinalizer, coordinator } = options;
  const now = options.now ?? Date.now;
  const reportOwners = {
    async resolve({
      accountId: requestedAccountId,
      presentationSessionId,
    }: {
      readonly accountId: string;
      readonly presentationSessionId: string;
    }) {
      const presentation = store.presentations.get(presentationSessionId);
      if (presentation?.lifecycle.ownerAccountId !== requestedAccountId) return null;
      return {
        tenantId: requestedAccountId,
        presentationSessionId,
        ownerSubject: requestedAccountId,
      };
    },
  };
  const preparedEvidenceFor = (presentationSessionId: string) => {
    const presentation = store.presentations.get(presentationSessionId);
    return {
      label: "준비된 근거" as const,
      items:
        presentation === undefined
          ? []
          : [...presentation.candidates.values()].map(({ candidate }) => ({
              evidenceId: candidate.candidateId,
              sourceId: candidate.causal.source.sourceId,
              sourceUrl: null,
              provenance: candidate.provenance,
            })),
    };
  };
  // Narrow seam: the route moves the lifecycle as the authenticated account session without
  // ever seeing the coordinator itself.
  const endLifecycle =
    coordinator === undefined
      ? undefined
      : ({
          accountSessionId,
          presentationSessionId,
        }: {
          accountSessionId: string;
          presentationSessionId: string;
        }) => coordinator.endPresentation(accountSessionId, presentationSessionId, now());
  return createSessionReportRouteHandler(
    sessionReportFinalizer,
    reportOwners,
    {
      async resolve(principal) {
        return preparedEvidenceFor(principal.presentationSessionId);
      },
    },
    {
      async resolve(principal) {
        const presentation = store.presentations.get(principal.presentationSessionId);
        if (presentation === undefined) return null;
        const finalizedAtMs = now();
        return {
          endedOffsetMs: Math.max(0, finalizedAtMs - presentation.lifecycle.createdAtMs),
          finalizedAtMs,
          preparedEvidence: preparedEvidenceFor(principal.presentationSessionId),
        };
      },
      // Recovery only fires for a session whose lifecycle actually ended: resolving a context
      // for a live talk would let a report read finalize the report mid-presentation. The end
      // offset derives from the recorded endedAtMs so a late recovery keeps the talk's real
      // duration instead of stretching it to the retry time.
      async resolveEnded(principal) {
        const presentation = store.presentations.get(principal.presentationSessionId);
        if (presentation === undefined || presentation.lifecycle.status !== "ENDED") {
          return null;
        }
        const endedAtMs = presentation.lifecycle.endedAtMs ?? now();
        return {
          endedOffsetMs: Math.max(0, endedAtMs - presentation.lifecycle.createdAtMs),
          finalizedAtMs: now(),
          preparedEvidence: preparedEvidenceFor(principal.presentationSessionId),
        };
      },
    },
    endLifecycle,
  );
}

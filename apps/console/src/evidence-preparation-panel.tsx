import { Panel } from "@impromptu/ui";
import { useEffect, useState } from "react";
import { useAuth } from "./auth-session";
import { createCorrelationId, getDebugLogger } from "./debug-log";
import { EvidenceCard } from "./evidence-card";
import { messages } from "./i18n";
import type { PrivateEvidenceCardView } from "./session-client";

type PreparedEvidenceCard = PrivateEvidenceCardView &
  Readonly<{
    id: string;
    summary: string;
  }>;

export function EvidencePreparationPanel() {
  const { activePresentation, client, locale, session } = useAuth();
  const text = messages(locale);
  const canPrepare =
    activePresentation !== null &&
    activePresentation.manifestHash !== undefined &&
    session !== null &&
    activePresentation.slides.length > 0;
  const [preparedEvidence, setPreparedEvidence] = useState<readonly PreparedEvidenceCard[]>([]);
  const [failures, setFailures] = useState<readonly string[]>([]);
  const [pendingCount, setPendingCount] = useState(
    canPrepare && activePresentation !== null ? activePresentation.slides.length : 0,
  );

  useEffect(() => {
    setPreparedEvidence([]);
    setFailures([]);
    if (activePresentation === null || session === null) {
      setPendingCount(0);
      return;
    }
    const manifestHash = activePresentation.manifestHash;
    if (manifestHash === undefined || activePresentation.slides.length === 0) {
      setPendingCount(0);
      return;
    }

    // The logger is a process-wide singleton, so reading it inside the effect keeps it out
    // of the dependency list without pinning a stale reference.
    const log = getDebugLogger();
    let active = true;
    const controller = new AbortController();
    const scheduledDispatches = new Set<ReturnType<typeof setTimeout>>();
    setPendingCount(activePresentation.slides.length);
    for (const slide of activePresentation.slides) {
      // Dispatching one macrotask late keeps React StrictMode's synchronous
      // simulate-unmount-remount from wasting a whole batch of model requests: the stale
      // run's dispatches are cleared before they ever reach the network, while genuinely
      // stale or unmounted runs are still cancelled through the same controller.
      const dispatch = setTimeout(() => {
        scheduledDispatches.delete(dispatch);
        if (!active || controller.signal.aborted) return;
        void (async () => {
          const correlationId = createCorrelationId();
          try {
            const result = await log.timed(
              "ai",
              "evidence.recommend",
              () =>
                client.recommend(
                  session.csrfToken,
                  {
                    query: slide.accessibilityLabel,
                    // The label a browser can read is the deck title and an ordinal, which is
                    // not something a deck ever states. The ordinal lets the private side
                    // ground the request in the slide's own indexed words instead.
                    slideOrdinal: slide.ordinal,
                    deckVersion: activePresentation.deckVersion,
                    manifestHash,
                    maxResults: 3,
                  },
                  controller.signal,
                ),
              { correlationId, detail: { publicSlideKey: slide.publicSlideKey } },
            );
            if (!active) return;
            if (result.outcome !== "RECOMMEND") {
              // A non-RECOMMEND outcome used to vanish here, so the panel claimed there was
              // simply no evidence while the backend was actually refusing every slide.
              log.warn("ai", "evidence.refused", {
                correlationId,
                detail: { publicSlideKey: slide.publicSlideKey, outcome: result.outcome },
              });
              setFailures((current) => [...current, result.outcome]);
              return;
            }
            const cards = result.evidence.map((evidence) => ({
              ...evidence,
              id: `${slide.publicSlideKey}:${evidence.evidenceId}`,
              summary: result.recommendation.claim,
            }));
            setPreparedEvidence((current) => [...current, ...cards]);
          } catch (error) {
            if (controller.signal.aborted) return;
            const reason = error instanceof Error ? error.message : String(error);
            log.error("ai", "evidence.failed", {
              correlationId,
              detail: { publicSlideKey: slide.publicSlideKey, reason },
            });
            if (active) setFailures((current) => [...current, reason]);
          } finally {
            if (active) setPendingCount((current) => Math.max(0, current - 1));
          }
        })();
      }, 0);
      scheduledDispatches.add(dispatch);
    }
    return () => {
      active = false;
      for (const dispatch of scheduledDispatches) clearTimeout(dispatch);
      scheduledDispatches.clear();
      controller.abort();
    };
  }, [activePresentation, client, session]);

  let status: "PREPARING" | "READY" | "FAILED" | "EMPTY" = "EMPTY";
  if (pendingCount > 0) status = "PREPARING";
  else if (preparedEvidence.length > 0) status = "READY";
  else if (failures.length > 0) status = "FAILED";
  const firstFailure = failures[0];
  return (
    <Panel className="console-evidence-preparation" title={text.preparedEvidence} tone="inset">
      <div data-evidence-status={status}>
        {preparedEvidence.length === 0 ? null : (
          <ul className="console-evidence-list">
            {preparedEvidence.map((evidence) => (
              <li key={evidence.id}>
                <EvidenceCard
                  card={evidence}
                  text={{
                    summary: text.evidenceSummary,
                    sourceUrl: text.evidenceSourceUrl,
                    sourceDate: text.evidenceSourceDate,
                    internalApproved: text.evidenceInternalApproved,
                    externalUnknown: text.evidenceExternalUnknown,
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        <p className="console-evidence-caption" data-evidence-caption={status}>
          {pendingCount > 0
            ? text.evidencePreparingQuietly
            : preparedEvidence.length > 0
              ? text.evidencePrepared
              : failures.length > 0
                ? text.evidenceFailed.replace("{count}", String(failures.length))
                : text.evidenceEmpty}
        </p>
        {status === "FAILED" && firstFailure !== undefined ? (
          <p className="console-evidence-caption" data-evidence-failure-reason>
            {text.evidenceFailedReason.replace("{reason}", firstFailure)}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

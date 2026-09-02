import { Button, Panel } from "@impromptu/ui";
import { useCallback, useEffect, useId, useState } from "react";
import { useAuth } from "./auth-session";
import { messages } from "./i18n";
import type { LiveCandidateSnapshotView } from "./session-client";

function publishApprovalLoadEvent(detail: Readonly<Record<string, unknown>>): void {
  window.dispatchEvent(new CustomEvent("impromptu:approval-load", { detail }));
}

export function LivePublicationPage() {
  const titleId = useId();
  const { activePresentation, client, locale, session } = useAuth();
  const text = messages(locale);
  const presentationSessionId = activePresentation?.presentationSessionId ?? "";
  const [snapshot, setSnapshot] = useState<LiveCandidateSnapshotView | null>(null);
  const [pendingCandidateId, setPendingCandidateId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const loadSnapshot = useCallback(async () => {
    setMessage(text.loadingSnapshot);
    try {
      const next = await client.readLiveCandidates(presentationSessionId);
      setSnapshot(next);
      publishApprovalLoadEvent({ type: "SNAPSHOT_LOADED", atMs: performance.now() });
      setMessage(
        next.livePublicEnabled
          ? locale === "ko"
            ? `검토할 실시간 제안 ${next.candidates.length}개를 불러왔습니다.`
            : `${next.candidates.length} fresh live candidate${next.candidates.length === 1 ? "" : "s"}.`
          : locale === "ko"
            ? "실시간 공개가 비활성화되어 있습니다. 확인된 제안은 비공개로 유지됩니다."
            : "Live public is fail-closed. Verified candidates remain private.",
      );
    } catch {
      setSnapshot(null);
      setMessage(text.snapshotFailed);
    }
  }, [client, locale, presentationSessionId, text]);

  useEffect(() => {
    if (activePresentation !== null) void loadSnapshot();
  }, [activePresentation, loadSnapshot]);

  const approve = async (candidate: LiveCandidateSnapshotView["candidates"][number]) => {
    if (snapshot === null || session === null) return;
    setPendingCandidateId(candidate.candidateId);
    setMessage(text.submittingApproval);
    const approvalId = crypto.randomUUID();
    publishApprovalLoadEvent({
      type: "APPROVAL_REQUESTED",
      approvalId,
      atMs: performance.now(),
    });
    let outcome = "REJECTED";
    try {
      await client.approveLiveCandidate(session.csrfToken, snapshot, candidate, approvalId);
      outcome = "PUBLISHED";
      setSnapshot(null);
      setMessage(text.published);
    } catch {
      setSnapshot(null);
      setMessage(text.liveApprovalFailed);
    } finally {
      publishApprovalLoadEvent({
        type: "APPROVAL_SETTLED",
        approvalId,
        outcome,
        atMs: performance.now(),
      });
      setPendingCandidateId(null);
    }
  };

  return (
    <section className="console-stack ui-reveal" aria-labelledby={titleId}>
      <div>
        <h1 id={titleId}>{text.liveApproval}</h1>
        <p className="console-lead">{text.liveApprovalLead}</p>
      </div>
      <Panel title={text.snapshotTitle} tone="inset">
        <p>{activePresentation === null ? text.approvalNeedsDeck : text.autoSuggestions}</p>
        <Button disabled={presentationSessionId.length === 0} onClick={() => void loadSnapshot()}>
          {activePresentation === null ? text.loadCandidates : text.refreshSuggestions}
        </Button>
        <p className="console-caption" aria-live="polite">
          {message || text.approvalInitial}
        </p>
      </Panel>
      {snapshot?.candidates.map((candidate) => (
        <Panel key={candidate.candidateId} title={candidate.claimText}>
          <p>{candidate.evidenceExcerpt}</p>
          <Button
            disabled={!snapshot.livePublicEnabled || pendingCandidateId !== null}
            onClick={() => void approve(candidate)}
          >
            {pendingCandidateId === candidate.candidateId ? text.approving : text.approveCard}
          </Button>
        </Panel>
      ))}
    </section>
  );
}

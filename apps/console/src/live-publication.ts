// Live publication: reading the authoritative candidate snapshot and approving a
// candidate for public publication.

import {
  mutationHeaders,
  type PrivateClientContext,
  responseBody,
  stringField,
} from "./private-transport";

export interface LiveCandidateSnapshotView {
  readonly authoritativeSnapshotHash: string;
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly publicationPolicyVersion: string;
  readonly publicationAuthorityId: string;
  readonly publicCardRevision: string;
  readonly livePublicEnabled: boolean;
  readonly candidates: readonly Readonly<{
    candidateId: string;
    candidateVersion: string;
    candidateRevision: string;
    claimText: string;
    evidenceExcerpt: string;
    occurrence: Readonly<{ publicSlideKey: string; occurrenceSeq: number }>;
  }>[];
}

function isLiveCandidateSnapshot(value: unknown): value is LiveCandidateSnapshotView {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.authoritativeSnapshotHash !== "string" ||
    typeof candidate.presentationSessionId !== "string" ||
    typeof candidate.presentationSessionEpoch !== "string" ||
    typeof candidate.publicationPolicyVersion !== "string" ||
    typeof candidate.publicationAuthorityId !== "string" ||
    typeof candidate.publicCardRevision !== "string" ||
    typeof candidate.livePublicEnabled !== "boolean" ||
    !Array.isArray(candidate.candidates)
  ) {
    return false;
  }
  return candidate.candidates.every((valueCandidate) => {
    if (typeof valueCandidate !== "object" || valueCandidate === null) return false;
    const live = valueCandidate as Record<string, unknown>;
    const occurrence = live.occurrence;
    return (
      typeof live.candidateId === "string" &&
      typeof live.candidateVersion === "string" &&
      typeof live.candidateRevision === "string" &&
      typeof live.claimText === "string" &&
      typeof live.evidenceExcerpt === "string" &&
      typeof occurrence === "object" &&
      occurrence !== null &&
      typeof (occurrence as Record<string, unknown>).publicSlideKey === "string" &&
      typeof (occurrence as Record<string, unknown>).occurrenceSeq === "number"
    );
  });
}

export async function readLiveCandidates(
  context: PrivateClientContext,
  presentationSessionId: string,
): Promise<LiveCandidateSnapshotView> {
  const response = await fetch(
    `${context.baseUrl}/v1/publications/live-candidates?presentationSessionId=${encodeURIComponent(presentationSessionId)}`,
    { credentials: "include" },
  );
  const body = await responseBody(response);
  if (!response.ok || !isLiveCandidateSnapshot(body)) {
    throw new Error("A fresh live-candidate snapshot could not be read.");
  }
  return body;
}

export async function approveLiveCandidate(
  context: PrivateClientContext,
  csrfToken: string,
  snapshot: LiveCandidateSnapshotView,
  candidate: LiveCandidateSnapshotView["candidates"][number],
  approvalId: string,
): Promise<void> {
  const response = await fetch(`${context.baseUrl}/v1/publications/approve`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(csrfToken),
    body: JSON.stringify({
      presentationSessionId: snapshot.presentationSessionId,
      candidateId: candidate.candidateId,
      candidateVersion: candidate.candidateVersion,
      expectedCandidateRevision: candidate.candidateRevision,
      expectedPublicCardRevision: snapshot.publicCardRevision,
      authorityId: snapshot.publicationAuthorityId,
      approvalId,
      authoritativeSnapshotHash: snapshot.authoritativeSnapshotHash,
      expiresAtMs: null,
    }),
  });
  if (!response.ok) {
    const body = await responseBody(response);
    throw new Error(stringField(body, "error") ?? "approval_rejected");
  }
}

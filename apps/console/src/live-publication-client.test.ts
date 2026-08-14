import { expect, test } from "bun:test";
import { createConsoleSessionClient } from "./session-client";

const snapshot = {
  authoritativeSnapshotHash: "snapshot-live-1",
  presentationSessionId: "ps_live-1",
  presentationSessionEpoch: "pse_1",
  publicationPolicyVersion: "publication-policy-1",
  publicationAuthorityId: "pubauth_live-1",
  publicCardRevision: "pcr_4",
  livePublicEnabled: true,
  candidates: [
    {
      candidateId: "candidate_live-1",
      candidateVersion: "candidate-version-2",
      candidateRevision: "candrev_1",
      claimText: "Live claim",
      evidenceExcerpt: "Live evidence",
      occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 2 },
    },
  ],
} as const;

test("Console submits only candidate CAS identity from a fresh authoritative snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return request.method === "GET"
      ? Response.json(snapshot)
      : Response.json({ projectionId: "projection_live-1", status: "PUBLISHED" }, { status: 201 });
  }) as typeof fetch;
  try {
    const client = createConsoleSessionClient("https://private.example.test");
    const fresh = await client.readLiveCandidates("ps_live-1");
    const candidate = fresh.candidates[0];
    if (candidate === undefined) throw new Error("live candidate fixture missing");
    await client.approveLiveCandidate("csrf-live", fresh, candidate, "approval-live-1");

    expect(requests[0]?.url).toBe(
      "https://private.example.test/v1/publications/live-candidates?presentationSessionId=ps_live-1",
    );
    expect(requests[0]?.credentials).toBe("include");
    expect(await requests[1]?.json()).toEqual({
      presentationSessionId: "ps_live-1",
      candidateId: "candidate_live-1",
      candidateVersion: "candidate-version-2",
      expectedCandidateRevision: "candrev_1",
      expectedPublicCardRevision: "pcr_4",
      authorityId: "pubauth_live-1",
      approvalId: "approval-live-1",
      authoritativeSnapshotHash: "snapshot-live-1",
      expiresAtMs: null,
    });
    expect(requests[1]?.headers.get("x-csrf-token")).toBe("csrf-live");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

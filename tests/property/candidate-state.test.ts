import { describe, expect, test } from "bun:test";
import {
  CandidateIdSchema,
  candidateRevision,
  PresentationSessionEpochSchema,
  PresentationSessionIdSchema,
} from "@impromptu/contracts/private";
import {
  createCandidateLifecycle,
  reduceCandidateLifecycle,
  restoreCandidateLifecycle,
  snapshotCandidateLifecycle,
} from "../../packages/state/src/index.ts";

const hash = (character: string) => character.repeat(64);
const sessionId = PresentationSessionIdSchema.parse("ps_session-1");
const sessionEpoch = PresentationSessionEpochSchema.parse("pse_3");
const candidateId = CandidateIdSchema.parse("candidate_primary");

function candidate() {
  return createCandidateLifecycle({
    presentationSessionId: sessionId,
    presentationSessionEpoch: sessionEpoch,
    candidateId,
    candidateVersion: "candidate-v1",
    contentHash: hash("c"),
  });
}

function operation(
  type: "QUALIFY" | "MARK_STALE" | "SUPERSEDE",
  revision: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    type,
    presentationSessionId: sessionId,
    presentationSessionEpoch: sessionEpoch,
    candidateId,
    candidateVersion: "candidate-v1",
    expectedRevision: candidateRevision(revision),
    ...overrides,
  };
}

describe("candidate lifecycle persistence", () => {
  test("enforces epoch, freshness, CAS, legal verdicts, and terminal publication", () => {
    const initial = candidate();
    expect(
      reduceCandidateLifecycle(
        initial,
        operation("QUALIFY", 99, { presentationSessionEpoch: "pse_2" }),
      ),
    ).toMatchObject({ outcome: "REJECTED", reason: "STALE_SESSION_EPOCH", state: initial });
    expect(
      reduceCandidateLifecycle(
        initial,
        operation("QUALIFY", 99, { candidateVersion: "candidate-v2" }),
      ),
    ).toMatchObject({ outcome: "REJECTED", reason: "STALE_CANDIDATE_VERSION", state: initial });
    expect(reduceCandidateLifecycle(initial, operation("QUALIFY", 99))).toMatchObject({
      outcome: "REJECTED",
      reason: "CAS_MISMATCH",
      state: initial,
    });
    expect(
      reduceCandidateLifecycle(initial, {
        ...operation("QUALIFY", 0),
        type: "PUBLISH",
        projectionId: "projection_candidate-1",
        publicCardRevision: "pcr_1",
      }),
    ).toMatchObject({ outcome: "REJECTED", reason: "ILLEGAL_TRANSITION" });

    const eligible = reduceCandidateLifecycle(initial, operation("QUALIFY", 0));
    expect(eligible.outcome).toBe("APPLIED");
    if (eligible.outcome !== "APPLIED") throw new Error("candidate was not qualified");
    const published = reduceCandidateLifecycle(eligible.state, {
      ...operation("QUALIFY", 1),
      type: "PUBLISH",
      projectionId: "projection_candidate-1",
      publicCardRevision: "pcr_1",
    });
    expect(published).toMatchObject({
      outcome: "APPLIED",
      state: {
        status: "PUBLISHED",
        candidateRevision: "candrev_2",
        publication: {
          projectionId: "projection_candidate-1",
          publicCardRevision: "pcr_1",
        },
      },
    });
    if (published.outcome !== "APPLIED") throw new Error("candidate was not published");
    expect(reduceCandidateLifecycle(published.state, operation("MARK_STALE", 2))).toMatchObject({
      outcome: "REJECTED",
      reason: "TERMINAL_VERDICT",
      state: published.state,
    });
  });

  test("rejects forged gaps, event identity, terminal verdict, publication, and unsafe counters", () => {
    const eligible = reduceCandidateLifecycle(candidate(), operation("QUALIFY", 0));
    if (eligible.outcome !== "APPLIED") throw new Error("candidate was not qualified");
    const published = reduceCandidateLifecycle(eligible.state, {
      ...operation("QUALIFY", 1),
      type: "PUBLISH",
      projectionId: "projection_candidate-1",
      publicCardRevision: "pcr_1",
    });
    if (published.outcome !== "APPLIED") throw new Error("candidate was not published");
    const snapshot = snapshotCandidateLifecycle(published.state);
    const restored = restoreCandidateLifecycle(structuredClone(snapshot));
    expect(restored).toEqual({ outcome: "RESTORED", state: published.state });
    expect(
      restoreCandidateLifecycle({
        ...snapshot,
        eventsByRevision: { candrev_2: snapshot.eventsByRevision.candrev_2 },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restoreCandidateLifecycle({
        ...snapshot,
        eventsByRevision: {
          ...snapshot.eventsByRevision,
          candrev_1: { ...snapshot.eventsByRevision.candrev_1, presentationSessionEpoch: "pse_2" },
        },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(restoreCandidateLifecycle({ ...snapshot, status: "ELIGIBLE" })).toEqual({
      outcome: "INVALID_SNAPSHOT",
    });
    expect(restoreCandidateLifecycle({ ...snapshot, publication: null })).toEqual({
      outcome: "INVALID_SNAPSHOT",
    });
    expect(() =>
      restoreCandidateLifecycle({ ...snapshot, candidateRevision: "candrev_9007199254740992" }),
    ).not.toThrow();
    expect(
      restoreCandidateLifecycle({ ...snapshot, candidateRevision: "candrev_9007199254740992" }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
  });
});

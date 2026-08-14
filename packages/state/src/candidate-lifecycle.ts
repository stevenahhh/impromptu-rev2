import { type CandidateId, CandidateIdSchema } from "@impromptu/contracts/private";

export type CandidateLifecycleStatus = "PRIVATE" | "ELIGIBLE" | "STALE" | "SUPERSEDED";

export type CandidateLifecycleState = Readonly<{
  candidateId: CandidateId;
  candidateVersion: string;
  contentHash: string;
  status: CandidateLifecycleStatus;
}>;

export type CandidateLifecycleOperation = Readonly<{
  type: "QUALIFY" | "MARK_STALE" | "SUPERSEDE";
  candidateVersion: string;
}>;

export type CandidateLifecycleResult =
  | Readonly<{ outcome: "APPLIED"; state: CandidateLifecycleState }>
  | Readonly<{
      outcome: "REJECTED";
      reason: "VERSION_MISMATCH" | "ILLEGAL_TRANSITION" | "TERMINAL_CANDIDATE";
      state: CandidateLifecycleState;
    }>;

export function createCandidateLifecycle(
  candidateId: string,
  candidateVersion: string,
  contentHash: string,
): CandidateLifecycleState {
  return {
    candidateId: CandidateIdSchema.parse(candidateId),
    candidateVersion,
    contentHash,
    status: "PRIVATE",
  };
}

export function reduceCandidateLifecycle(
  state: CandidateLifecycleState,
  operation: CandidateLifecycleOperation,
): CandidateLifecycleResult {
  if (operation.candidateVersion !== state.candidateVersion) {
    return { state, outcome: "REJECTED", reason: "VERSION_MISMATCH" };
  }
  if (state.status === "STALE" || state.status === "SUPERSEDED") {
    return { state, outcome: "REJECTED", reason: "TERMINAL_CANDIDATE" };
  }
  if (operation.type === "QUALIFY" && state.status !== "PRIVATE") {
    return { state, outcome: "REJECTED", reason: "ILLEGAL_TRANSITION" };
  }
  const status: CandidateLifecycleStatus =
    operation.type === "QUALIFY"
      ? "ELIGIBLE"
      : operation.type === "MARK_STALE"
        ? "STALE"
        : "SUPERSEDED";
  return { outcome: "APPLIED", state: { ...state, status } };
}

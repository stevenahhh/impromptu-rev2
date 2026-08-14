export type PublicationStatus = "PRIVATE" | "ELIGIBLE" | "PUBLISHED" | "RETRACTED" | "EXPIRED";
export type PublicationOperationType = "QUALIFY" | "APPROVE" | "RETRACT" | "EXPIRE";

export const PUBLICATION_TRANSITIONS = {
  PRIVATE: ["QUALIFY"],
  ELIGIBLE: ["APPROVE"],
  PUBLISHED: ["RETRACT", "EXPIRE"],
  RETRACTED: [],
  EXPIRED: [],
} as const satisfies Record<PublicationStatus, readonly PublicationOperationType[]>;

type PublicationOperationHeader = Readonly<{
  commandId: string;
  requestHash: string;
  expectedRevision: number;
}>;

export type PublicationOperation =
  | (PublicationOperationHeader & Readonly<{ type: "QUALIFY" }>)
  | (PublicationOperationHeader &
      Readonly<{
        type: "APPROVE";
        candidateVersion: string;
        projectionId: string;
      }>)
  | (PublicationOperationHeader &
      Readonly<{
        type: "RETRACT" | "EXPIRE";
        projectionId: string;
      }>);

export type PublicationAccepted = Readonly<{
  outcome: "ACCEPTED";
  revision: number;
  status: PublicationStatus;
}>;
export type PublicationRejected = Readonly<{
  outcome: "REJECTED";
  reason:
    | "CAS_CONFLICT"
    | "ILLEGAL_TRANSITION"
    | "IDEMPOTENCY_CONFLICT"
    | "CANDIDATE_VERSION_MISMATCH"
    | "PROJECTION_MISMATCH";
}>;
export type PublicationResult = PublicationAccepted | PublicationRejected;

type AcceptedPublicationRecord = Readonly<{
  requestHash: string;
  result: PublicationAccepted;
}>;

export type PublicationState = Readonly<{
  candidateId: string;
  candidateVersion: string;
  projectionId: string | null;
  status: PublicationStatus;
  revision: number;
  acceptedOperations: Readonly<Record<string, AcceptedPublicationRecord>>;
}>;

export function createPublicationState(
  candidateId: string,
  candidateVersion: string,
): PublicationState {
  return {
    candidateId,
    candidateVersion,
    projectionId: null,
    status: "PRIVATE",
    revision: 0,
    acceptedOperations: {},
  };
}

export type PublicationReduction = Readonly<{
  state: PublicationState;
  result: PublicationResult;
}>;

function rejected(
  state: PublicationState,
  reason: PublicationRejected["reason"],
): PublicationReduction {
  return { state, result: { outcome: "REJECTED", reason } };
}

function isLegal(status: PublicationStatus, type: PublicationOperationType): boolean {
  const transitions: readonly PublicationOperationType[] = PUBLICATION_TRANSITIONS[status];
  return transitions.includes(type);
}

export function reducePublication(
  state: PublicationState,
  operation: PublicationOperation,
): PublicationReduction {
  const prior = state.acceptedOperations[operation.commandId];
  if (prior !== undefined) {
    if (prior.requestHash !== operation.requestHash) {
      return rejected(state, "IDEMPOTENCY_CONFLICT");
    }
    return { state, result: prior.result };
  }
  if (operation.expectedRevision !== state.revision) {
    return rejected(state, "CAS_CONFLICT");
  }
  if (!isLegal(state.status, operation.type)) {
    return rejected(state, "ILLEGAL_TRANSITION");
  }
  if (operation.type === "APPROVE" && operation.candidateVersion !== state.candidateVersion) {
    return rejected(state, "CANDIDATE_VERSION_MISMATCH");
  }
  if (
    (operation.type === "RETRACT" || operation.type === "EXPIRE") &&
    operation.projectionId !== state.projectionId
  ) {
    return rejected(state, "PROJECTION_MISMATCH");
  }

  const status: PublicationStatus =
    operation.type === "QUALIFY"
      ? "ELIGIBLE"
      : operation.type === "APPROVE"
        ? "PUBLISHED"
        : operation.type === "RETRACT"
          ? "RETRACTED"
          : "EXPIRED";
  const revision = state.revision + 1;
  const result: PublicationAccepted = { outcome: "ACCEPTED", revision, status };
  const projectionId = operation.type === "APPROVE" ? operation.projectionId : state.projectionId;
  return {
    state: {
      ...state,
      status,
      revision,
      projectionId,
      acceptedOperations: {
        ...state.acceptedOperations,
        [operation.commandId]: { requestHash: operation.requestHash, result },
      },
    },
    result,
  };
}

import {
  type CandidateId,
  CandidateIdSchema,
  type CandidateRevision,
  CandidateRevisionSchema,
  candidateRevision,
  candidateRevisionValue,
  type PresentationSessionEpoch,
  PresentationSessionEpochSchema,
  type PresentationSessionId,
  PresentationSessionIdSchema,
} from "@impromptu/contracts/private";
import {
  type ProjectionId,
  ProjectionIdSchema,
  type PublicCardRevision,
  PublicCardRevisionSchema,
} from "@impromptu/contracts/public";
import {
  Sha256Schema,
  safeEncodedCounterValue,
  VersionIdSchema,
} from "@impromptu/contracts/shared";
import { z } from "zod";

export type CandidateLifecycleStatus =
  | "PRIVATE"
  | "ELIGIBLE"
  | "STALE"
  | "SUPERSEDED"
  | "PUBLISHED";

const operationIdentityShape = {
  presentationSessionId: PresentationSessionIdSchema,
  presentationSessionEpoch: PresentationSessionEpochSchema,
  candidateId: CandidateIdSchema,
  candidateVersion: VersionIdSchema,
  expectedRevision: CandidateRevisionSchema,
};

const CandidateVerdictOperationSchema = z.discriminatedUnion("type", [
  z.object({ ...operationIdentityShape, type: z.literal("QUALIFY") }).strict(),
  z.object({ ...operationIdentityShape, type: z.literal("MARK_STALE") }).strict(),
  z.object({ ...operationIdentityShape, type: z.literal("SUPERSEDE") }).strict(),
  z
    .object({
      ...operationIdentityShape,
      type: z.literal("PUBLISH"),
      projectionId: ProjectionIdSchema,
      publicCardRevision: PublicCardRevisionSchema.refine(
        (revision) => safeEncodedCounterValue(revision) !== 0,
        "publication revision must be positive",
      ),
    })
    .strict(),
]);

export type CandidateLifecycleOperation = z.infer<typeof CandidateVerdictOperationSchema>;
export type CandidatePublication = Readonly<{
  projectionId: ProjectionId;
  publicCardRevision: PublicCardRevision;
}>;

export type CandidateLifecycleState = Readonly<{
  presentationSessionId: PresentationSessionId;
  presentationSessionEpoch: PresentationSessionEpoch;
  candidateId: CandidateId;
  candidateVersion: string;
  contentHash: string;
  candidateRevision: CandidateRevision;
  status: CandidateLifecycleStatus;
  publication: CandidatePublication | null;
  eventsByRevision: Readonly<Record<string, CandidateLifecycleOperation>>;
}>;

export type CreateCandidateLifecycle = Readonly<{
  presentationSessionId: PresentationSessionId;
  presentationSessionEpoch: PresentationSessionEpoch;
  candidateId: CandidateId;
  candidateVersion: string;
  contentHash: string;
}>;

export function createCandidateLifecycle(input: CreateCandidateLifecycle): CandidateLifecycleState {
  const parsed = z
    .object({
      presentationSessionId: PresentationSessionIdSchema,
      presentationSessionEpoch: PresentationSessionEpochSchema,
      candidateId: CandidateIdSchema,
      candidateVersion: VersionIdSchema,
      contentHash: Sha256Schema,
    })
    .strict()
    .parse(input);
  return {
    ...parsed,
    candidateRevision: candidateRevision(0),
    status: "PRIVATE",
    publication: null,
    eventsByRevision: {},
  };
}

export type CandidateLifecycleRejectionReason =
  | "INVALID_OPERATION"
  | "STALE_SESSION_EPOCH"
  | "STALE_CANDIDATE_VERSION"
  | "CAS_MISMATCH"
  | "TERMINAL_VERDICT"
  | "ILLEGAL_TRANSITION";

export type CandidateLifecycleResult =
  | Readonly<{ outcome: "APPLIED"; state: CandidateLifecycleState }>
  | Readonly<{
      outcome: "REJECTED";
      reason: CandidateLifecycleRejectionReason;
      state: CandidateLifecycleState;
    }>;

function rejected(
  state: CandidateLifecycleState,
  reason: CandidateLifecycleRejectionReason,
): CandidateLifecycleResult {
  return { outcome: "REJECTED", reason, state };
}

export function reduceCandidateLifecycle(
  state: CandidateLifecycleState,
  input: unknown,
): CandidateLifecycleResult {
  const parsed = CandidateVerdictOperationSchema.safeParse(input);
  if (!parsed.success) return rejected(state, "INVALID_OPERATION");
  const operation = parsed.data;
  if (
    operation.presentationSessionId !== state.presentationSessionId ||
    operation.presentationSessionEpoch !== state.presentationSessionEpoch
  ) {
    return rejected(state, "STALE_SESSION_EPOCH");
  }
  if (
    operation.candidateId !== state.candidateId ||
    operation.candidateVersion !== state.candidateVersion
  ) {
    return rejected(state, "STALE_CANDIDATE_VERSION");
  }
  if (operation.expectedRevision !== state.candidateRevision) {
    return rejected(state, "CAS_MISMATCH");
  }
  if (state.status === "STALE" || state.status === "SUPERSEDED" || state.status === "PUBLISHED") {
    return rejected(state, "TERMINAL_VERDICT");
  }
  if (
    (operation.type === "QUALIFY" && state.status !== "PRIVATE") ||
    (operation.type === "PUBLISH" && state.status !== "ELIGIBLE")
  ) {
    return rejected(state, "ILLEGAL_TRANSITION");
  }

  const nextRevision = candidateRevision(candidateRevisionValue(state.candidateRevision) + 1);
  const status: CandidateLifecycleStatus =
    operation.type === "QUALIFY"
      ? "ELIGIBLE"
      : operation.type === "MARK_STALE"
        ? "STALE"
        : operation.type === "SUPERSEDE"
          ? "SUPERSEDED"
          : "PUBLISHED";
  return {
    outcome: "APPLIED",
    state: {
      ...state,
      candidateRevision: nextRevision,
      status,
      publication:
        operation.type === "PUBLISH"
          ? {
              projectionId: operation.projectionId,
              publicCardRevision: operation.publicCardRevision,
            }
          : null,
      eventsByRevision: { ...state.eventsByRevision, [nextRevision]: operation },
    },
  };
}

export const CandidateLifecycleSnapshotSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    presentationSessionEpoch: PresentationSessionEpochSchema,
    candidateId: CandidateIdSchema,
    candidateVersion: VersionIdSchema,
    contentHash: Sha256Schema,
    candidateRevision: CandidateRevisionSchema,
    status: z.enum(["PRIVATE", "ELIGIBLE", "STALE", "SUPERSEDED", "PUBLISHED"]),
    publication: z
      .object({
        projectionId: ProjectionIdSchema,
        publicCardRevision: PublicCardRevisionSchema,
      })
      .strict()
      .nullable(),
    eventsByRevision: z.record(z.string(), CandidateVerdictOperationSchema),
  })
  .strict();

export function snapshotCandidateLifecycle(
  state: CandidateLifecycleState,
): CandidateLifecycleState {
  return state;
}

export type CandidateLifecycleRestoreResult =
  | Readonly<{ outcome: "RESTORED"; state: CandidateLifecycleState }>
  | Readonly<{ outcome: "INVALID_SNAPSHOT" }>;

export function restoreCandidateLifecycle(input: unknown): CandidateLifecycleRestoreResult {
  const parsed = CandidateLifecycleSnapshotSchema.safeParse(input);
  if (!parsed.success) return { outcome: "INVALID_SNAPSHOT" };
  const snapshot = parsed.data;
  const head = safeEncodedCounterValue(snapshot.candidateRevision);
  if (head === null || Object.keys(snapshot.eventsByRevision).length !== head) {
    return { outcome: "INVALID_SNAPSHOT" };
  }

  let replayed = createCandidateLifecycle({
    presentationSessionId: snapshot.presentationSessionId,
    presentationSessionEpoch: snapshot.presentationSessionEpoch,
    candidateId: snapshot.candidateId,
    candidateVersion: snapshot.candidateVersion,
    contentHash: snapshot.contentHash,
  });
  for (let revision = 1; revision <= head; revision += 1) {
    const key = candidateRevision(revision);
    const operation = snapshot.eventsByRevision[key];
    if (operation === undefined || operation.expectedRevision !== candidateRevision(revision - 1)) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
    const result = reduceCandidateLifecycle(replayed, operation);
    if (result.outcome !== "APPLIED") return { outcome: "INVALID_SNAPSHOT" };
    replayed = result.state;
  }

  return JSON.stringify(replayed) === JSON.stringify(snapshot)
    ? { outcome: "RESTORED", state: snapshot }
    : { outcome: "INVALID_SNAPSHOT" };
}

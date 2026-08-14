import {
  type PublicationAuthority,
  PublicationAuthoritySchema,
} from "@impromptu/contracts/private";
import {
  type PresentationSessionEpoch,
  PresentationSessionEpochSchema,
  type PresentationSessionId,
  PresentationSessionIdSchema,
  type PublicationTombstone,
  PublicationTombstoneSchema,
  type PublicCardRevision,
  PublicCardRevisionSchema,
  type PublishedAudienceCard,
  PublishedAudienceCardSchema,
  publicCardRevision,
  publicCardRevisionValue,
} from "@impromptu/contracts/public";
import { safeEncodedCounterValue } from "@impromptu/contracts/shared";
import { z } from "zod";
import type { CandidateLifecycleState } from "./candidate-lifecycle.ts";

const PublicCardEventSchema = z.union([PublishedAudienceCardSchema, PublicationTombstoneSchema]);
export type PublicCardEvent = z.infer<typeof PublicCardEventSchema>;

const PublicCardStreamSnapshotSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    presentationSessionEpoch: PresentationSessionEpochSchema,
    authority: PublicationAuthoritySchema.nullable(),
    publicCardRevision: PublicCardRevisionSchema,
    tombstoneWatermark: PublicCardRevisionSchema,
    cards: z.record(z.string(), PublishedAudienceCardSchema),
    tombstones: z.record(z.string(), PublicationTombstoneSchema),
    eventsByRevision: z.record(z.string(), PublicCardEventSchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const head = safeEncodedCounterValue(snapshot.publicCardRevision);
    const watermark = safeEncodedCounterValue(snapshot.tombstoneWatermark);
    if (head === null || watermark === null) return;
    if (watermark > head) {
      context.addIssue({
        code: "custom",
        path: ["tombstoneWatermark"],
        message: "watermark exceeds stream head",
      });
    }
    if (
      snapshot.authority !== null &&
      (snapshot.authority.presentationSessionId !== snapshot.presentationSessionId ||
        snapshot.authority.presentationSessionEpoch !== snapshot.presentationSessionEpoch)
    ) {
      context.addIssue({
        code: "custom",
        path: ["authority"],
        message: "authority belongs to another session",
      });
    }
    for (const [key, card] of Object.entries(snapshot.cards)) {
      const revision = safeEncodedCounterValue(card.publicCardRevision);
      if (
        revision === null ||
        key !== card.projectionId ||
        revision > head ||
        revision <= watermark
      ) {
        context.addIssue({
          code: "custom",
          path: ["cards", key],
          message: "invalid active card snapshot entry",
        });
      }
      if (snapshot.tombstones[card.projectionId] !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["cards", key],
          message: "terminal projection cannot be active",
        });
      }
    }
    for (const [key, tombstone] of Object.entries(snapshot.tombstones)) {
      if (
        key !== tombstone.projectionId ||
        (safeEncodedCounterValue(tombstone.publicCardRevision) ?? Number.POSITIVE_INFINITY) > head
      ) {
        context.addIssue({
          code: "custom",
          path: ["tombstones", key],
          message: "invalid tombstone snapshot entry",
        });
      }
    }
    for (const [key, event] of Object.entries(snapshot.eventsByRevision)) {
      if (
        key !== event.publicCardRevision ||
        (safeEncodedCounterValue(event.publicCardRevision) ?? Number.POSITIVE_INFINITY) > head
      ) {
        context.addIssue({
          code: "custom",
          path: ["eventsByRevision", key],
          message: "invalid event history entry",
        });
      }
    }
  });

export type PublicCardStreamState = Readonly<{
  presentationSessionId: PresentationSessionId;
  presentationSessionEpoch: PresentationSessionEpoch;
  authority: PublicationAuthority | null;
  publicCardRevision: PublicCardRevision;
  tombstoneWatermark: PublicCardRevision;
  cards: Readonly<Record<string, PublishedAudienceCard>>;
  tombstones: Readonly<Record<string, PublicationTombstone>>;
  eventsByRevision: Readonly<Record<string, PublicCardEvent>>;
}>;

export type CreatePublicCardStream = Readonly<{
  presentationSessionId: PresentationSessionId;
  presentationSessionEpoch: PresentationSessionEpoch;
  authority?: PublicationAuthority | null;
}>;

export function createPublicCardStream(input: CreatePublicCardStream): PublicCardStreamState {
  if (
    input.authority !== undefined &&
    input.authority !== null &&
    (input.authority.presentationSessionId !== input.presentationSessionId ||
      input.authority.presentationSessionEpoch !== input.presentationSessionEpoch)
  ) {
    throw new Error("publication authority belongs to a different presentation session");
  }
  return {
    presentationSessionId: input.presentationSessionId,
    presentationSessionEpoch: input.presentationSessionEpoch,
    authority: input.authority ?? null,
    publicCardRevision: publicCardRevision(0),
    tombstoneWatermark: publicCardRevision(0),
    cards: {},
    tombstones: {},
    eventsByRevision: {},
  };
}

export type PublicCardEventOutcome =
  | "APPLIED"
  | "DUPLICATE"
  | "GAP_REQUIRES_SNAPSHOT"
  | "STALE_OR_CONFLICTING"
  | "TERMINAL_PROJECTION"
  | "INVALID_EVENT";
export type PublicCardEventResult = Readonly<{
  state: PublicCardStreamState;
  outcome: PublicCardEventOutcome;
}>;

function eventRevision(event: PublicCardEvent): PublicCardRevision {
  return event.publicCardRevision;
}

function sameEvent(left: PublicCardEvent, right: PublicCardEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function applyPublicCardEvent(
  state: PublicCardStreamState,
  input: unknown,
): PublicCardEventResult {
  const parsed = PublicCardEventSchema.safeParse(input);
  if (!parsed.success) return { state, outcome: "INVALID_EVENT" };
  const event = parsed.data;
  const revision = eventRevision(event);
  const currentValue = publicCardRevisionValue(state.publicCardRevision);
  const eventValue = publicCardRevisionValue(revision);
  if (eventValue <= currentValue) {
    const prior = state.eventsByRevision[revision];
    return {
      state,
      outcome:
        prior !== undefined && sameEvent(prior, event) ? "DUPLICATE" : "STALE_OR_CONFLICTING",
    };
  }
  if (eventValue !== currentValue + 1) {
    return { state, outcome: "GAP_REQUIRES_SNAPSHOT" };
  }
  if (state.tombstones[event.projectionId] !== undefined) {
    return { state, outcome: "TERMINAL_PROJECTION" };
  }

  if (event.status === "PUBLISHED") {
    return {
      state: {
        ...state,
        publicCardRevision: revision,
        cards: { ...state.cards, [event.projectionId]: event },
        eventsByRevision: { ...state.eventsByRevision, [revision]: event },
      },
      outcome: "APPLIED",
    };
  }

  const cards = { ...state.cards };
  delete cards[event.projectionId];
  return {
    state: {
      ...state,
      publicCardRevision: revision,
      cards,
      tombstones: { ...state.tombstones, [event.projectionId]: event },
      eventsByRevision: { ...state.eventsByRevision, [revision]: event },
    },
    outcome: "APPLIED",
  };
}

const AuthorizedPublicCardEventSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    presentationSessionEpoch: PresentationSessionEpochSchema,
    authorityId: PublicationAuthoritySchema.shape.authorityId,
    expectedRevision: PublicCardRevisionSchema,
    payload: PublicCardEventSchema,
  })
  .strict();

export type AuthorizedPublicCardResult =
  | Readonly<{ outcome: "APPLIED"; state: PublicCardStreamState }>
  | Readonly<{
      outcome: "REJECTED";
      reason:
        | "INVALID_EVENT"
        | "STALE_SESSION_EPOCH"
        | "STALE_AUTHORITY"
        | "AUTHORITY_EXPIRED"
        | "CAS_CONFLICT"
        | "CANDIDATE_NOT_ELIGIBLE"
        | "TERMINAL_PROJECTION"
        | "GAP_REQUIRES_SNAPSHOT";
      state: PublicCardStreamState;
    }>;

export function applyAuthorizedPublicCardEvent(
  state: PublicCardStreamState,
  candidate: CandidateLifecycleState | null,
  input: unknown,
  nowMs: number,
): AuthorizedPublicCardResult {
  const parsed = AuthorizedPublicCardEventSchema.safeParse(input);
  if (!parsed.success) return { state, outcome: "REJECTED", reason: "INVALID_EVENT" };
  const event = parsed.data;
  if (
    event.presentationSessionId !== state.presentationSessionId ||
    event.presentationSessionEpoch !== state.presentationSessionEpoch
  ) {
    return { state, outcome: "REJECTED", reason: "STALE_SESSION_EPOCH" };
  }
  if (state.authority === null || event.authorityId !== state.authority.authorityId) {
    return { state, outcome: "REJECTED", reason: "STALE_AUTHORITY" };
  }
  if (nowMs >= state.authority.expiresAtMs) {
    return { state, outcome: "REJECTED", reason: "AUTHORITY_EXPIRED" };
  }
  if (event.expectedRevision !== state.publicCardRevision) {
    return { state, outcome: "REJECTED", reason: "CAS_CONFLICT" };
  }
  if (event.payload.status === "PUBLISHED" && candidate?.status !== "ELIGIBLE") {
    return { state, outcome: "REJECTED", reason: "CANDIDATE_NOT_ELIGIBLE" };
  }
  const applied = applyPublicCardEvent(state, event.payload);
  if (applied.outcome === "APPLIED") {
    return { state: applied.state, outcome: "APPLIED" };
  }
  const reason =
    applied.outcome === "TERMINAL_PROJECTION"
      ? "TERMINAL_PROJECTION"
      : applied.outcome === "GAP_REQUIRES_SNAPSHOT"
        ? "GAP_REQUIRES_SNAPSHOT"
        : "INVALID_EVENT";
  return { state, outcome: "REJECTED", reason };
}

export type PublicCardStreamRestoreResult =
  | Readonly<{ outcome: "RESTORED"; state: PublicCardStreamState }>
  | Readonly<{ outcome: "INVALID_SNAPSHOT" }>;

export function restorePublicCardStream(input: unknown): PublicCardStreamRestoreResult {
  const parsed = PublicCardStreamSnapshotSchema.safeParse(input);
  return parsed.success
    ? { outcome: "RESTORED", state: parsed.data }
    : { outcome: "INVALID_SNAPSHOT" };
}

export function publicCardStreamFromSnapshot(
  current: PublicCardStreamState,
  input: {
    presentationSessionId: PresentationSessionId;
    presentationSessionEpoch: PresentationSessionEpoch;
    publicCardRevision: PublicCardRevision;
    tombstoneWatermark: PublicCardRevision;
    cards: readonly PublishedAudienceCard[];
    tombstones: readonly PublicationTombstone[];
  },
): PublicCardStreamRestoreResult {
  const cards = Object.fromEntries(input.cards.map((card) => [card.projectionId, card]));
  const tombstones = Object.fromEntries(
    input.tombstones.map((tombstone) => [tombstone.projectionId, tombstone]),
  );
  const eventsByRevision = Object.fromEntries(
    [...input.cards, ...input.tombstones].map((event) => [event.publicCardRevision, event]),
  );
  return restorePublicCardStream({
    presentationSessionId: input.presentationSessionId,
    presentationSessionEpoch: input.presentationSessionEpoch,
    authority: current.authority,
    publicCardRevision: input.publicCardRevision,
    tombstoneWatermark: input.tombstoneWatermark,
    cards,
    tombstones,
    eventsByRevision,
  });
}

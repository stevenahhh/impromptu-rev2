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

export const PublicCardStreamStateSchema = z
  .object({
    stateKind: z.literal("AUTHORITATIVE_PUBLIC_CARD_STREAM"),
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
    if (watermark !== 0) {
      context.addIssue({
        code: "custom",
        path: ["tombstoneWatermark"],
        message: "uncompacted event history requires a zero watermark",
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
    const orderedEvents = new Map<number, PublicCardEvent>();
    for (const [key, event] of Object.entries(snapshot.eventsByRevision)) {
      const revision = safeEncodedCounterValue(event.publicCardRevision);
      if (
        key !== event.publicCardRevision ||
        revision === null ||
        revision < 1 ||
        revision > head ||
        orderedEvents.has(revision)
      ) {
        context.addIssue({
          code: "custom",
          path: ["eventsByRevision", key],
          message: "invalid or duplicate event history revision",
        });
        continue;
      }
      orderedEvents.set(revision, event);
    }
    if (orderedEvents.size !== head) {
      context.addIssue({
        code: "custom",
        path: ["eventsByRevision"],
        message: "event history must contain every revision through the stream head",
      });
      return;
    }

    const derivedCards: Record<string, PublishedAudienceCard> = {};
    const derivedTombstones: Record<string, PublicationTombstone> = {};
    for (let revision = 1; revision <= head; revision += 1) {
      const event = orderedEvents.get(revision);
      if (event === undefined) {
        context.addIssue({
          code: "custom",
          path: ["eventsByRevision"],
          message: "event history contains a revision gap",
        });
        return;
      }
      if (derivedTombstones[event.projectionId] !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["eventsByRevision", event.publicCardRevision],
          message: "terminal projection cannot be resurrected",
        });
        return;
      }
      if (event.status === "PUBLISHED") {
        derivedCards[event.projectionId] = event;
        continue;
      }
      delete derivedCards[event.projectionId];
      derivedTombstones[event.projectionId] = event;
    }

    const cardsMatch =
      Object.keys(snapshot.cards).length === Object.keys(derivedCards).length &&
      Object.entries(derivedCards).every(
        ([key, card]) => JSON.stringify(snapshot.cards[key]) === JSON.stringify(card),
      );
    const tombstonesMatch =
      Object.keys(snapshot.tombstones).length === Object.keys(derivedTombstones).length &&
      Object.entries(derivedTombstones).every(
        ([key, tombstone]) =>
          JSON.stringify(snapshot.tombstones[key]) === JSON.stringify(tombstone),
      );
    if (!cardsMatch || !tombstonesMatch) {
      context.addIssue({
        code: "custom",
        path: ["eventsByRevision"],
        message: "materialized card state conflicts with event history",
      });
    }
  })
  .brand<"PublicCardStreamState">();

export type PublicCardStreamState = z.infer<typeof PublicCardStreamStateSchema>;

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
  return PublicCardStreamStateSchema.parse({
    stateKind: "AUTHORITATIVE_PUBLIC_CARD_STREAM",
    presentationSessionId: input.presentationSessionId,
    presentationSessionEpoch: input.presentationSessionEpoch,
    authority: input.authority ?? null,
    publicCardRevision: publicCardRevision(0),
    tombstoneWatermark: publicCardRevision(0),
    cards: {},
    tombstones: {},
    eventsByRevision: {},
  });
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
      state: PublicCardStreamStateSchema.parse({
        ...state,
        publicCardRevision: revision,
        cards: { ...state.cards, [event.projectionId]: event },
        eventsByRevision: { ...state.eventsByRevision, [revision]: event },
      }),
      outcome: "APPLIED",
    };
  }

  const cards = { ...state.cards };
  delete cards[event.projectionId];
  return {
    state: PublicCardStreamStateSchema.parse({
      ...state,
      publicCardRevision: revision,
      cards,
      tombstones: { ...state.tombstones, [event.projectionId]: event },
      eventsByRevision: { ...state.eventsByRevision, [revision]: event },
    }),
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
  const parsed = PublicCardStreamStateSchema.safeParse(input);
  return parsed.success
    ? { outcome: "RESTORED", state: parsed.data }
    : { outcome: "INVALID_SNAPSHOT" };
}

import { z } from "zod";
import { PublicSlideOccurrenceSchema, TimestampMsSchema } from "./common.ts";
import { ActorIdSchema, ControlRevisionSchema } from "./control-identifiers.ts";
import { PublishedDeckArtifactSchema } from "./public-deck.ts";
import { DeckVersionIdSchema, DisplayBindingEpochSchema } from "./public-identifiers.ts";
import {
  PresentationSessionEpochSchema,
  PresentationSessionIdSchema,
} from "./session-identifiers.ts";

/**
 * Owner-scoped presentation library contracts (GAP-10): the private list and resume reads a
 * presenter needs to re-enter an already-uploaded deck without re-uploading. Everything here
 * is derived server-side from the owned presentation record; a client never posts fields the
 * server must trust, and no private deck fields (speaker notes, object prefixes, extracted
 * text, asset ids) ever appear in these DTOs.
 */

export const PresentationSummarySchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    presentationSessionEpoch: PresentationSessionEpochSchema,
    /** Display title: the presenter-set name, or the uploaded file's deck title. */
    title: z.string().min(1).max(500),
    status: z.enum(["ACTIVE", "ENDED"]),
    createdAtMs: TimestampMsSchema,
    updatedAtMs: TimestampMsSchema,
    endedAtMs: TimestampMsSchema.nullable(),
    deckVersion: DeckVersionIdSchema,
    slideCount: z.number().int().positive(),
  })
  .strict();
export type PresentationSummary = z.infer<typeof PresentationSummarySchema>;

export const PresentationListResponseSchema = z
  .object({
    presentations: z.array(PresentationSummarySchema),
    /**
     * Opaque server-issued continuation token for the owner's next page; null ends the list.
     * Clients treat it as unreadable: it is echoed back verbatim, never constructed.
     */
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();
export type PresentationListResponse = z.infer<typeof PresentationListResponseSchema>;

/**
 * The playback state a re-entering presenter needs: the control revision CAS base, the
 * current display-binding epoch, and the lease identity it may have to take over when the
 * new account session carries a different actor.
 */
export const PresentationPlaybackStateSchema = z
  .object({
    displayBindingEpoch: DisplayBindingEpochSchema,
    controlRevision: ControlRevisionSchema,
    stageStatus: z.enum(["READY", "DISCONNECTED", "UNBOUND"]),
    occurrence: PublicSlideOccurrenceSchema,
    activeLease: z
      .object({
        actorId: ActorIdSchema,
        expiresAtMs: TimestampMsSchema,
      })
      .strict(),
  })
  .strict();
export type PresentationPlaybackState = z.infer<typeof PresentationPlaybackStateSchema>;

export const PresentationDetailResponseSchema = z
  .object({
    presentation: PresentationSummarySchema,
    publicDeck: PublishedDeckArtifactSchema,
    playback: PresentationPlaybackStateSchema,
  })
  .strict();
export type PresentationDetailResponse = z.infer<typeof PresentationDetailResponseSchema>;

export const PresentationRenameRequestSchema = z
  .object({
    title: z.string().min(1).max(500),
  })
  .strict();
export type PresentationRenameRequest = z.infer<typeof PresentationRenameRequestSchema>;

export const PresentationRenameResponseSchema = z
  .object({
    presentation: PresentationSummarySchema,
  })
  .strict();
export type PresentationRenameResponse = z.infer<typeof PresentationRenameResponseSchema>;

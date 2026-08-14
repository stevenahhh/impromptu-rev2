import {
  type PresentationSessionEpoch,
  PresentationSessionEpochSchema,
  type PresentationSessionId,
  PresentationSessionIdSchema,
  PublicationTombstoneSchema,
  PublicCardRevisionSchema,
  PublishedAudienceCardSchema,
  publicCardRevision,
} from "@impromptu/contracts/public";
import { safeEncodedCounterValue } from "@impromptu/contracts/shared";
import { z } from "zod";

export const AudienceCardSnapshotStateSchema = z
  .object({
    stateKind: z.literal("COMPACT_AUDIENCE_CARD_SNAPSHOT"),
    presentationSessionId: PresentationSessionIdSchema,
    presentationSessionEpoch: PresentationSessionEpochSchema,
    publicCardRevision: PublicCardRevisionSchema,
    tombstoneWatermark: PublicCardRevisionSchema,
    cards: z.record(z.string(), PublishedAudienceCardSchema),
    tombstones: z.record(z.string(), PublicationTombstoneSchema),
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
        message: "watermark exceeds compacted stream head",
      });
      return;
    }

    const active = new Set<string>();
    const terminal = new Set<string>();
    const retainedRevisions = new Set<number>();
    const postWatermarkRevisions = new Set<number>();
    for (const [key, card] of Object.entries(snapshot.cards)) {
      const revision = safeEncodedCounterValue(card.publicCardRevision);
      if (
        key !== card.projectionId ||
        revision === null ||
        revision <= watermark ||
        revision > head ||
        retainedRevisions.has(revision)
      ) {
        context.addIssue({
          code: "custom",
          path: ["cards", key],
          message: "invalid compacted active card",
        });
        continue;
      }
      active.add(card.projectionId);
      retainedRevisions.add(revision);
      postWatermarkRevisions.add(revision);
    }
    for (const [key, tombstone] of Object.entries(snapshot.tombstones)) {
      const revision = safeEncodedCounterValue(tombstone.publicCardRevision);
      if (
        key !== tombstone.projectionId ||
        revision === null ||
        revision > head ||
        terminal.has(tombstone.projectionId) ||
        active.has(tombstone.projectionId) ||
        retainedRevisions.has(revision)
      ) {
        context.addIssue({
          code: "custom",
          path: ["tombstones", key],
          message: "invalid compacted tombstone",
        });
        continue;
      }
      terminal.add(tombstone.projectionId);
      retainedRevisions.add(revision);
      if (revision > watermark) postWatermarkRevisions.add(revision);
    }
    if (postWatermarkRevisions.size !== head - watermark) {
      context.addIssue({
        code: "custom",
        path: ["publicCardRevision"],
        message: "compacted card state has a post-watermark revision gap",
      });
    }
  })
  .brand<"AudienceCardSnapshotState">();

export type AudienceCardSnapshotState = z.infer<typeof AudienceCardSnapshotStateSchema>;

export function createAudienceCardSnapshotState(input: {
  presentationSessionId: PresentationSessionId;
  presentationSessionEpoch: PresentationSessionEpoch;
}): AudienceCardSnapshotState {
  return AudienceCardSnapshotStateSchema.parse({
    stateKind: "COMPACT_AUDIENCE_CARD_SNAPSHOT",
    presentationSessionId: input.presentationSessionId,
    presentationSessionEpoch: input.presentationSessionEpoch,
    publicCardRevision: publicCardRevision(0),
    tombstoneWatermark: publicCardRevision(0),
    cards: {},
    tombstones: {},
  });
}

export type AudienceCardSnapshotRestoreResult =
  | Readonly<{ outcome: "RESTORED"; state: AudienceCardSnapshotState }>
  | Readonly<{ outcome: "INVALID_SNAPSHOT" }>;

export function restoreAudienceCardSnapshotState(
  input: unknown,
): AudienceCardSnapshotRestoreResult {
  const parsed = AudienceCardSnapshotStateSchema.safeParse(input);
  return parsed.success
    ? { outcome: "RESTORED", state: parsed.data }
    : { outcome: "INVALID_SNAPSHOT" };
}

export function snapshotAudienceCardState(input: unknown): AudienceCardSnapshotRestoreResult {
  const parsed = restoreAudienceCardSnapshotState(input);
  return parsed.outcome === "RESTORED"
    ? { outcome: "RESTORED", state: structuredClone(parsed.state) }
    : parsed;
}

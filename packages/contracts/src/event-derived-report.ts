import { z } from "zod";

import { type PublicationDispatchDto, PublicationDispatchSchema } from "./publication-dispatch.ts";

const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: true });

export const PublicationEventLogSchema = z.array(PublicationDispatchSchema).min(1);

export const EventDerivedReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    tenantId: UuidSchema,
    projectionId: UuidSchema,
    eventCount: z.number().int().positive(),
    finalRevision: z.number().int().nonnegative(),
    projectionUpdateCount: z.number().int().nonnegative(),
    publishedCardCount: z.number().int().nonnegative(),
    retractedCardCount: z.number().int().nonnegative(),
    activeCardCount: z.number().int().nonnegative(),
    finalProjectionState: z.enum(["bound", "active", "ended"]),
    firstPublishedAt: TimestampSchema.nullable(),
    endedAt: TimestampSchema.nullable(),
  })
  .strict();

export type PublicationEventLog = z.infer<typeof PublicationEventLogSchema>;
export type EventDerivedReport = z.infer<typeof EventDerivedReportSchema>;

function eventRevision(event: PublicationDispatchDto): number {
  return event.publicPayload.revision;
}

export function deriveEventReport(input: readonly PublicationDispatchDto[]): EventDerivedReport {
  const events = PublicationEventLogSchema.parse(input);
  const first = events[0];
  if (!first) throw new Error("publication event log must not be empty");

  const dispatchKeys = new Set<string>();
  const activeCards = new Set<string>();
  let previousRevision: number | null = null;
  let projectionUpdateCount = 0;
  let publishedCardCount = 0;
  let retractedCardCount = 0;
  let finalProjectionState: EventDerivedReport["finalProjectionState"] = "bound";
  let firstPublishedAt: string | null = null;
  let endedAt: string | null = null;

  for (const event of events) {
    if (event.tenantId !== first.tenantId || event.projectionId !== first.projectionId) {
      throw new Error("publication event log must contain a single tenant and projection");
    }
    if (dispatchKeys.has(event.dispatchKey)) {
      throw new Error("publication event log contains a duplicate dispatch key");
    }
    dispatchKeys.add(event.dispatchKey);

    const revision = eventRevision(event);
    if (previousRevision !== null && revision !== previousRevision + 1) {
      throw new Error("publication event log must have contiguous revision order");
    }
    previousRevision = revision;

    switch (event.eventKind) {
      case "upsert_projection":
        projectionUpdateCount += 1;
        finalProjectionState = event.publicPayload.state;
        break;
      case "publish_card":
        publishedCardCount += 1;
        activeCards.add(event.publicPayload.cardId);
        firstPublishedAt ??= event.publicPayload.publishedAt;
        break;
      case "retract_card":
        retractedCardCount += 1;
        activeCards.delete(event.publicPayload.cardId);
        break;
      case "end_projection":
        finalProjectionState = "ended";
        endedAt = event.publicPayload.endedAt;
        activeCards.clear();
        break;
    }
  }

  return EventDerivedReportSchema.parse({
    schemaVersion: 1,
    tenantId: first.tenantId,
    projectionId: first.projectionId,
    eventCount: events.length,
    finalRevision: previousRevision,
    projectionUpdateCount,
    publishedCardCount,
    retractedCardCount,
    activeCardCount: activeCards.size,
    finalProjectionState,
    firstPublishedAt,
    endedAt,
  });
}

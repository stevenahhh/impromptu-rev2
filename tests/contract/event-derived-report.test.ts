import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EventDerivedReportSchema,
  PublicationEventLogSchema,
  deriveEventReport,
} from "@impromptu/contracts/public";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/publication-event-log.json"), "utf8"),
);

describe("event-derived presentation report", () => {
  test("derives the exact closed report from a fixed publication event log", () => {
    const events = PublicationEventLogSchema.parse(fixture);
    const report = deriveEventReport(events);

    expect(report).toEqual({
      schemaVersion: 1,
      tenantId: "10000000-0000-4000-8000-000000000001",
      projectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      eventCount: 5,
      finalRevision: 5,
      projectionUpdateCount: 2,
      publishedCardCount: 1,
      retractedCardCount: 1,
      activeCardCount: 0,
      finalProjectionState: "ended",
      firstPublishedAt: "2026-08-14T08:00:00Z",
      endedAt: "2026-08-14T08:30:00Z",
    });
    expect(EventDerivedReportSchema.parse(report)).toEqual(report);
    expect(EventDerivedReportSchema.safeParse({ ...report, provider: "forbidden" }).success).toBe(
      false,
    );
  });

  test("rejects mixed projections, duplicate dispatches, and revision gaps", () => {
    const events = PublicationEventLogSchema.parse(fixture);
    const first = events[0]!;
    const second = events[1]!;
    const third = events[2]!;
    const foreignProjection = PublicationEventLogSchema.parse([
      { ...second, projectionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    ])[0]!;

    expect(() => deriveEventReport([...events, first])).toThrow("duplicate dispatch key");
    expect(() => deriveEventReport([first, foreignProjection])).toThrow(
      "single tenant and projection",
    );
    expect(() => deriveEventReport([first, third])).toThrow("contiguous revision");
  });
});

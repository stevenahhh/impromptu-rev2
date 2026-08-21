import postgres from "../../services/private-backend/node_modules/postgres";
import {
  createPostgresSessionReportRepository,
  SessionReportAccessDeniedError,
  SessionReportFinalizedError,
  SessionReportStateConflictError,
} from "../../services/private-backend/src/report/postgres-session-report-repository.ts";

const privateDatabaseUrl = Bun.env.PRIVATE_DATABASE_URL;
if (privateDatabaseUrl === undefined) {
  throw new Error("PRIVATE_DATABASE_URL is required");
}

const sql = postgres(privateDatabaseUrl, { max: 1 });
const owner = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  presentationSessionId: "11111111-1111-4111-8111-111111111111",
  ownerSubject: "account:tenant-a-owner",
};

try {
  await sql`SET ROLE private_app`;
  const reports = createPostgresSessionReportRepository(sql);
  const visits = [
    await reports.appendSlideVisit({
      ...owner,
      presentationSessionEpoch: 7,
      seq: 1,
      publicSlideKey: "slide-a",
      enteredOffsetMs: 100,
      leftOffsetMs: 400,
      producerId: "visit-a-1",
    }),
    await reports.appendSlideVisit({
      ...owner,
      presentationSessionEpoch: 7,
      seq: 2,
      publicSlideKey: "slide-b",
      enteredOffsetMs: 400,
      leftOffsetMs: 700,
      producerId: "visit-b-1",
    }),
    await reports.appendSlideVisit({
      ...owner,
      presentationSessionEpoch: 7,
      seq: 3,
      publicSlideKey: "slide-a",
      enteredOffsetMs: 700,
      leftOffsetMs: 1_100,
      producerId: "visit-a-2",
    }),
  ];
  assert(
    visits.map((result) => result.visit.occurrenceSeq).join(",") === "1,1,2",
    "A -> B -> A must retain distinct occurrence sequence numbers",
  );
  assert(
    visits.map((result) => result.visit.leftOffsetMs - result.visit.enteredOffsetMs).join(",") ===
      "300,300,400",
    "A -> B -> A must retain each visit dwell duration",
  );
  const duplicate = await reports.appendSlideVisit({
    ...owner,
    presentationSessionEpoch: 7,
    seq: 3,
    publicSlideKey: "slide-a",
    enteredOffsetMs: 700,
    leftOffsetMs: 1_100,
    producerId: "visit-a-2",
  });
  assert(
    duplicate.outcome === "DUPLICATE" && duplicate.visit.occurrenceSeq === 2,
    "producer id must make a visit append idempotent",
  );

  const first = await reports.compareAndSetState({
    ...owner,
    expectedRevision: 0,
    speechSummary: "Derived summary only",
    wordCount: 12,
    speakingDurationMs: 1_000,
    coachingAggregate: { cueCount: 2, measurementUnavailable: false },
    finalizedAtMs: null,
  });
  assert(first.revision === 1, "first CAS write must create revision 1");
  const current = await reports.compareAndSetState({
    ...owner,
    expectedRevision: 1,
    speechSummary: "Updated derived summary only",
    wordCount: 15,
    speakingDurationMs: 1_200,
    coachingAggregate: { cueCount: 3, measurementUnavailable: false },
    finalizedAtMs: null,
  });
  assert(current.revision === 2, "current CAS write must advance revision");
  await expectError(
    () =>
      reports.compareAndSetState({
        ...owner,
        expectedRevision: 1,
        speechSummary: "Stale derived summary only",
        wordCount: 11,
        speakingDurationMs: 900,
        coachingAggregate: {},
        finalizedAtMs: null,
      }),
    SessionReportStateConflictError,
    "stale report writer must be rejected",
  );
  const finalized = await reports.compareAndSetState({
    ...owner,
    expectedRevision: 2,
    speechSummary: "Final derived summary only",
    wordCount: 15,
    speakingDurationMs: 1_200,
    coachingAggregate: { cueCount: 3, measurementUnavailable: false },
    finalizedAtMs: 1_760_000_000_000,
  });
  assert(
    finalized.revision === 3 && finalized.finalizedAtMs === 1_760_000_000_000,
    "CAS finalizes",
  );
  await expectError(
    () =>
      reports.compareAndSetState({
        ...owner,
        expectedRevision: 3,
        speechSummary: "Must not replace finalized state",
        wordCount: 15,
        speakingDurationMs: 1_200,
        coachingAggregate: {},
        finalizedAtMs: null,
      }),
    SessionReportFinalizedError,
    "finalized report state must be immutable",
  );
  await expectError(
    () => reports.readForOwner({ ...owner, ownerSubject: "account:tenant-a-observer" }),
    SessionReportAccessDeniedError,
    "same-tenant non-owner must not read the report",
  );

  console.log("PostgreSQL session report visits, CAS, owner check, and finalization verified.");
} finally {
  await sql.end({ timeout: 5 });
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectError(
  operation: () => Promise<unknown>,
  expected: new (message: string) => Error,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof expected) return;
    throw error;
  }
  throw new Error(message);
}

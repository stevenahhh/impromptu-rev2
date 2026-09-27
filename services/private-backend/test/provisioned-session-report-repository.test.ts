import { describe, expect, test } from "bun:test";

import { SessionReportAccessDeniedError } from "../src/report/postgres-session-report-repository.ts";
import {
  createProvisionedSessionReportRepository,
  presentationSessionUuid,
  tenantUuidForAccount,
} from "../src/report/provisioned-session-report-repository.ts";
import { SessionReportFinalizer } from "../src/report/session-report-finalizer.ts";
import {
  fakeProvisioningSql,
  OwnershipCheckedReportRepository,
} from "./support/provisioning-harness.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("session report identity", () => {
  // The report tables are keyed by uuid while the product identifies accounts and presentations
  // with opaque strings. Every value handed to them has to be a uuid or the write dies with
  // `invalid input syntax for type uuid`, which is what stopped any report from finalizing.
  test("maps an account id to a stable uuid", () => {
    const first = tenantUuidForAccount("account_local_demo");
    expect(first).toMatch(UUID);
    expect(tenantUuidForAccount("account_local_demo")).toBe(first);
    expect(tenantUuidForAccount("account_other")).not.toBe(first);
  });

  test("re-encodes a ps_ session id without losing its identity", () => {
    const hex = "cc0edfaffd67ecd4992a508f1e4910a3";
    const uuid = presentationSessionUuid(`ps_${hex}`);
    expect(uuid).toMatch(UUID);
    // Re-encoded, not hashed: the original 128 bits are still readable in the uuid.
    expect(uuid.replaceAll("-", "")).toBe(hex);
    expect(presentationSessionUuid(`ps_${hex.toUpperCase()}`)).toBe(uuid);
  });

  test("falls back to a derived uuid for an unexpected session id shape", () => {
    const uuid = presentationSessionUuid("session-without-the-expected-shape");
    expect(uuid).toMatch(UUID);
    expect(presentationSessionUuid("session-without-the-expected-shape")).toBe(uuid);
    expect(presentationSessionUuid("another-session")).not.toBe(uuid);
  });
});

describe("provisioned session report repository ownership rows", () => {
  const principal = {
    tenantId: "account_owner",
    presentationSessionId: "ps_00000000000000000000000000000abc",
    ownerSubject: "account_owner",
  };
  const preparedEvidence = { label: "준비된 근거" as const, items: [] };

  function wiredRepository() {
    const rows = {
      tenants: new Map<string, string>(),
      sessions: new Map<string, { readonly ownerSubject: string; readonly epoch: number }>(),
    };
    const { sql, beginCount } = fakeProvisioningSql(rows);
    const repository = createProvisionedSessionReportRepository(
      sql,
      new OwnershipCheckedReportRepository(rows.sessions),
    );
    return { repository, rows, beginCount };
  }

  // Live-baseline F2: a session that never recorded a slide visit or Q&A exchange has no
  // presentation_sessions row, so endSession's first read used to die on assertOwner and the
  // report stayed unreachable forever. The owning rows must exist before ANY repository access,
  // not just before the first write.
  test("ends a zero-activity session into a real finalized report", async () => {
    const { repository } = wiredRepository();
    const finalizer = new SessionReportFinalizer(repository);

    const accepted = await finalizer.endSession({
      principal,
      endedOffsetMs: 42_000,
      finalizedAtMs: 1_700_000_000_000,
      preparedEvidence,
    });
    const result = await accepted.finalization;

    expect(result.outcome).toBe("FINALIZED");
    if (result.outcome !== "FINALIZED") throw result.error;
    expect(result.report.presentationSessionId).toBe(principal.presentationSessionId);
    expect(result.report.finalizedAtMs).toBe(1_700_000_000_000);
    expect(result.report.slideVisits).toEqual([]);
    expect(result.report.qaDefense?.exchanges).toEqual([]);
    const reloaded = await finalizer.readFinalizedReport(principal, preparedEvidence);
    expect(reloaded).toEqual(result.report);
  });

  test("provisions the tenant and session rows before an owner read", async () => {
    const { repository, rows } = wiredRepository();

    const state = await repository.readForOwner(principal);

    expect(state).toBeNull();
    const tenantId = tenantUuidForAccount(principal.tenantId);
    const sessionId = presentationSessionUuid(principal.presentationSessionId);
    expect(rows.tenants.get(tenantId)).toBe(principal.tenantId);
    expect(rows.sessions.get(`${tenantId}:${sessionId}`)).toEqual({
      ownerSubject: principal.ownerSubject,
      epoch: 1,
    });
  });

  test("keeps denying a subject that does not own the session row", async () => {
    const { repository, rows } = wiredRepository();
    const tenantId = tenantUuidForAccount(principal.tenantId);
    const sessionId = presentationSessionUuid(principal.presentationSessionId);
    // An existing row owned by someone else: provisioning must NOT overwrite it (ON CONFLICT
    // DO NOTHING), and the inner assertOwner still throws for the mismatched subject.
    rows.sessions.set(`${tenantId}:${sessionId}`, {
      ownerSubject: "account_other",
      epoch: 3,
    });

    await expect(repository.readForOwner(principal)).rejects.toBeInstanceOf(
      SessionReportAccessDeniedError,
    );
    expect(rows.sessions.get(`${tenantId}:${sessionId}`)?.ownerSubject).toBe("account_other");
  });
});

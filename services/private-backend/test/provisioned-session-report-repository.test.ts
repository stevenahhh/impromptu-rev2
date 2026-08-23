import { describe, expect, test } from "bun:test";

import {
  presentationSessionUuid,
  tenantUuidForAccount,
} from "../src/report/provisioned-session-report-repository.ts";

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

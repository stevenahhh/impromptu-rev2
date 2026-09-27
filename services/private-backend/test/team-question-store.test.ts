import { describe, expect, test } from "bun:test";
import type { AccountId, PresentationSessionId } from "@impromptu/contracts/private";
import {
  createInMemoryTeamQuestionStore,
  type StoredTeamQuestionGrant,
} from "../src/team-question-grants.ts";

/**
 * Store-level pins for the question-only grant seam: conditional writes, idempotency,
 * tenant scoping and the liveness re-check adjacent to every append. These invariants are
 * the PostgreSQL store's contract too; the in-memory implementation is the deterministic
 * reference the HTTP tests run against.
 */

const OWNER = "account_owner_a" as AccountId;
const TEAMMATE = "account_teammate_b" as AccountId;
const STRANGER = "account_stranger_c" as AccountId;
const SESSION = "ps_0123456789abcdef0123456789abcdef" as PresentationSessionId;

function grantDraft(overrides: Partial<StoredTeamQuestionGrant> = {}): StoredTeamQuestionGrant {
  return {
    grantId: `tqg_${"a".repeat(32)}` as StoredTeamQuestionGrant["grantId"],
    tenantAccountId: OWNER,
    presentationSessionId: SESSION,
    ownerAccountId: OWNER,
    teammateAccountId: TEAMMATE,
    teammateUsername: "teammate-b",
    invitationTokenDigest: "d".repeat(64),
    idempotencyKey: "issue-1",
    revocationRevision: 1,
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    acceptedAtMs: null,
    revokedAtMs: null,
    ...overrides,
  };
}

describe("in-memory team question store", () => {
  test("create is idempotent on the caller key and conflicts on a changed payload", async () => {
    const store = createInMemoryTeamQuestionStore();
    const grant = grantDraft();
    expect(await store.createGrant(grant)).toEqual({ outcome: "CREATED", grant });
    const replay = await store.createGrant({ ...grantDraft(), grantId: grant.grantId });
    expect(replay.outcome).toBe("IDEMPOTENT_REPLAY");
    const conflict = await store.createGrant(
      grantDraft({
        idempotencyKey: "issue-1",
        teammateUsername: "someone-else",
        teammateAccountId: STRANGER,
      }),
    );
    expect(conflict).toEqual({ outcome: "REJECTED", reason: "IDEMPOTENCY_CONFLICT" });
  });

  test("owner and teammate lookups are scoped to their own identities", async () => {
    const store = createInMemoryTeamQuestionStore();
    await store.createGrant(grantDraft());
    expect(await store.findGrant(OWNER, grantDraft().grantId)).not.toBeNull();
    expect(await store.findGrant(STRANGER, grantDraft().grantId)).toBeNull();
    expect(await store.findGrantForTeammate(TEAMMATE, grantDraft().grantId)).not.toBeNull();
    expect(await store.findGrantForTeammate(STRANGER, grantDraft().grantId)).toBeNull();
    // The invitation digest resolves only in combination with the targeted account.
    expect(await store.findGrantByInvitationDigest(STRANGER, "d".repeat(64))).toBeNull();
    expect(await store.findGrantByInvitationDigest(TEAMMATE, "d".repeat(64))).not.toBeNull();
    expect(await store.findGrantByInvitationDigest(TEAMMATE, "e".repeat(64))).toBeNull();
  });

  test("accept is one-use and ordered before expiry", async () => {
    const store = createInMemoryTeamQuestionStore();
    const grant = grantDraft();
    await store.createGrant(grant);
    const accepted = await store.acceptGrant(
      { tenantAccountId: OWNER, grantId: grant.grantId, teammateAccountId: TEAMMATE },
      2_000,
    );
    expect(accepted.outcome).toBe("ACCEPTED");
    const second = await store.acceptGrant(
      { tenantAccountId: OWNER, grantId: grant.grantId, teammateAccountId: TEAMMATE },
      2_500,
    );
    expect(second).toEqual({ outcome: "REJECTED", reason: "GRANT_ALREADY_ACCEPTED" });
  });

  test("revocation bumps revocation_revision exactly once and blocks the append", async () => {
    const store = createInMemoryTeamQuestionStore();
    const grant = grantDraft();
    await store.createGrant(grant);
    await store.acceptGrant(
      { tenantAccountId: OWNER, grantId: grant.grantId, teammateAccountId: TEAMMATE },
      2_000,
    );
    const revoked = await store.revokeGrant(OWNER, grant.grantId, 3_000);
    expect(revoked.outcome).toBe("REVOKED");
    if (revoked.outcome === "REVOKED") {
      expect(revoked.grant.revocationRevision).toBe(2);
    }
    const second = await store.revokeGrant(OWNER, grant.grantId, 3_500);
    expect(second.outcome).toBe("ALREADY_REVOKED");
    if (second.outcome === "ALREADY_REVOKED") {
      expect(second.grant.revocationRevision).toBe(2);
    }
    const appended = await store.appendQuestion({
      grantId: grant.grantId,
      submitterAccountId: TEAMMATE,
      questionId: `tqq_${"b".repeat(32)}`,
      questionText: "post-revoke",
      idempotencyKey: "q-1",
      nowMs: 4_000,
    });
    expect(appended).toEqual({ outcome: "REJECTED", reason: "GRANT_REVOKED" });
    expect(await store.readInbox(OWNER, SESSION)).toHaveLength(0);
  });

  test("a stranger cannot revoke, and appends reject every inactive or foreign path", async () => {
    const store = createInMemoryTeamQuestionStore();
    const grant = grantDraft();
    await store.createGrant(grant);
    expect(await store.revokeGrant(STRANGER, grant.grantId, 2_000)).toEqual({
      outcome: "REJECTED",
      reason: "GRANT_UNKNOWN",
    });
    await store.acceptGrant(
      { tenantAccountId: OWNER, grantId: grant.grantId, teammateAccountId: TEAMMATE },
      2_000,
    );
    const foreign = await store.appendQuestion({
      grantId: grant.grantId,
      submitterAccountId: STRANGER,
      questionId: `tqq_${"c".repeat(32)}`,
      questionText: "foreign",
      idempotencyKey: "q-f",
      nowMs: 3_000,
    });
    expect(foreign).toEqual({ outcome: "REJECTED", reason: "GRANT_NOT_FOR_CALLER" });
    const expired = await store.appendQuestion({
      grantId: grant.grantId,
      submitterAccountId: TEAMMATE,
      questionId: `tqq_${"d".repeat(32)}`,
      questionText: "at the deadline",
      idempotencyKey: "q-exp",
      nowMs: 10_000,
    });
    expect(expired).toEqual({ outcome: "REJECTED", reason: "GRANT_EXPIRED" });
    const unknown = await store.appendQuestion({
      grantId: `tqg_${"f".repeat(32)}`,
      submitterAccountId: TEAMMATE,
      questionId: `tqq_${"e".repeat(32)}`,
      questionText: "no grant",
      idempotencyKey: "q-u",
      nowMs: 3_000,
    });
    expect(unknown).toEqual({ outcome: "REJECTED", reason: "GRANT_UNKNOWN" });
  });

  test("unaccepted grants cannot submit, and the inbox is tenant- and session-scoped", async () => {
    const store = createInMemoryTeamQuestionStore();
    const grant = grantDraft();
    await store.createGrant(grant);
    const early = await store.appendQuestion({
      grantId: grant.grantId,
      submitterAccountId: TEAMMATE,
      questionId: `tqq_${"1".repeat(32)}`,
      questionText: "before accept",
      idempotencyKey: "q-early",
      nowMs: 2_000,
    });
    expect(early).toEqual({ outcome: "REJECTED", reason: "GRANT_NOT_ACCEPTED" });

    // Two tenants' sessions interleave: inboxes never mix.
    const otherSession = "ps_fedcba9876543210fedcba9876543210" as PresentationSessionId;
    const otherGrant = grantDraft({
      grantId: `tqg_${"b".repeat(32)}` as StoredTeamQuestionGrant["grantId"],
      presentationSessionId: otherSession,
      invitationTokenDigest: "e".repeat(64),
      idempotencyKey: "issue-2",
    });
    await store.createGrant(otherGrant);
    await store.acceptGrant(
      { tenantAccountId: OWNER, grantId: grant.grantId, teammateAccountId: TEAMMATE },
      2_000,
    );
    await store.acceptGrant(
      { tenantAccountId: OWNER, grantId: otherGrant.grantId, teammateAccountId: TEAMMATE },
      2_000,
    );
    for (const [index, g] of [grant, otherGrant].entries()) {
      const appended = await store.appendQuestion({
        grantId: g.grantId,
        submitterAccountId: TEAMMATE,
        questionId: `tqq_${String(index + 2).repeat(32)}` as never,
        questionText: `question-${index}`,
        idempotencyKey: `q-${index}`,
        nowMs: 3_000 + index,
      });
      expect(appended.outcome).toBe("APPENDED");
    }
    expect((await store.readInbox(OWNER, SESSION)).map((q) => q.questionText)).toEqual([
      "question-0",
    ]);
    expect((await store.readInbox(OWNER, otherSession)).map((q) => q.questionText)).toEqual([
      "question-1",
    ]);
    expect(await store.readInbox(STRANGER, SESSION)).toHaveLength(0);
    expect((await store.listGrants(OWNER, SESSION)).map((g) => g.grantId)).toEqual([grant.grantId]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  AcceptTeamQuestionGrantRequestSchema,
  IssuedTeamQuestionGrantSchema,
  IssueTeamQuestionGrantRequestSchema,
  SubmitTeamQuestionRequestSchema,
  TEAM_QUESTION_TEXT_MAX,
  TeamQuestionGrantViewSchema,
  TeamQuestionInboxViewSchema,
  TeamQuestionReceiptSchema,
} from "@impromptu/contracts/private";

const grantView = {
  grantId: "tqg_a1b2c3d4e5f60718293a4b5c6d7e8f9a",
  presentationSessionId: "ps_0123456789abcdef0123456789abcdef",
  teammateAccountId: "account_teammate",
  teammateUsername: "teammate-b",
  status: "PENDING",
  revocationRevision: 1,
  expiresAtMs: 1_000,
  acceptedAtMs: null,
  revokedAtMs: null,
} as const;

describe("team question contracts", () => {
  test("the issue request is closed: only session, username and idempotency key", () => {
    const request = {
      presentationSessionId: "ps_0123456789abcdef0123456789abcdef",
      teammateUsername: "teammate-b",
      idempotencyKey: "key-1",
    };
    expect(IssueTeamQuestionGrantRequestSchema.safeParse(request).success).toBe(true);
    for (const malformed of [
      { ...request, invitationToken: "tginv_smuggled" },
      { ...request, accountId: "account_spoof" },
      { ...request, extra: true },
      { presentationSessionId: request.presentationSessionId, teammateUsername: "x" },
    ]) {
      expect(IssueTeamQuestionGrantRequestSchema.safeParse(malformed).success).toBe(false);
    }
  });

  test("the accept body carries only the opaque invitation token", () => {
    expect(
      AcceptTeamQuestionGrantRequestSchema.safeParse({
        invitationToken: `tginv_${"a".repeat(64)}`,
      }).success,
    ).toBe(true);
    expect(
      AcceptTeamQuestionGrantRequestSchema.safeParse({ invitationToken: "tginv_xyz" }).success,
    ).toBe(false);
    expect(
      AcceptTeamQuestionGrantRequestSchema.safeParse({
        invitationToken: `tginv_${"a".repeat(64)}`,
        accountId: "account_spoof",
      }).success,
    ).toBe(false);
  });

  test("the grant view is closed and never carries token or digest fields", () => {
    expect(TeamQuestionGrantViewSchema.safeParse(grantView).success).toBe(true);
    for (const leak of [
      { ...grantView, invitationToken: `tginv_${"a".repeat(64)}` },
      { ...grantView, invitationTokenDigest: "b".repeat(64) },
      { ...grantView, tokenDigest: "b".repeat(64) },
    ]) {
      expect(TeamQuestionGrantViewSchema.safeParse(leak).success).toBe(false);
    }
    // Issuance adds exactly one field: the one-time token.
    expect(
      IssuedTeamQuestionGrantSchema.safeParse({
        ...grantView,
        invitationToken: `tginv_${"a".repeat(64)}`,
      }).success,
    ).toBe(true);
  });

  test("submission text is trimmed and bounded at 2000 characters", () => {
    const base = {
      grantId: "tqg_a1b2c3d4e5f60718293a4b5c6d7e8f9a",
      idempotencyKey: "q-1",
    };
    const parsed = SubmitTeamQuestionRequestSchema.safeParse({
      ...base,
      questionText: "  padded question  ",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.questionText).toBe("padded question");
    for (const bad of [
      { ...base, questionText: "" },
      { ...base, questionText: "   " },
      { ...base, questionText: "x".repeat(TEAM_QUESTION_TEXT_MAX + 1) },
    ]) {
      expect(SubmitTeamQuestionRequestSchema.safeParse(bad).success).toBe(false);
    }
    expect(
      SubmitTeamQuestionRequestSchema.safeParse({
        ...base,
        questionText: "x".repeat(TEAM_QUESTION_TEXT_MAX),
      }).success,
    ).toBe(true);
  });

  test("receipt and inbox views are closed teammate/owner surfaces", () => {
    const receipt = {
      questionId: "tqq_a1b2c3d4e5f60718293a4b5c6d7e8f9a",
      grantId: grantView.grantId,
      submittedAtMs: 5_000,
      duplicate: false,
    };
    expect(TeamQuestionReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(TeamQuestionReceiptSchema.safeParse({ ...receipt, questionText: "leak" }).success).toBe(
      false,
    );
    expect(
      TeamQuestionInboxViewSchema.safeParse({
        presentationSessionId: grantView.presentationSessionId,
        questions: [
          {
            questionId: receipt.questionId,
            grantId: grantView.grantId,
            teammateAccountId: "account_teammate",
            teammateUsername: "teammate-b",
            questionText: "question",
            submittedAtMs: 5_000,
            questionSeq: 1,
          },
        ],
      }).success,
    ).toBe(true);
  });
});

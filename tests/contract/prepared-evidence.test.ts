import { describe, expect, test } from "bun:test";
import {
  AccountSessionSchema,
  DisplayApprovalSchema,
  DisplayJoinSchema,
  PresentationSessionLifecycleSchema,
} from "@impromptu/contracts/prepared-evidence";

describe("prepared evidence session contracts", () => {
  test("keeps account and presentation sessions distinct and closed", () => {
    expect(
      AccountSessionSchema.parse({
        accountSessionId: "account_session_alpha",
        accountId: "account_alpha",
        actorId: "actor_alpha",
        expiresAtMs: 10_000,
        revokedAtMs: null,
      }),
    ).toBeDefined();
    expect(
      PresentationSessionLifecycleSchema.safeParse({
        presentationSessionId: "ps_alpha",
        presentationSessionEpoch: "pse_1",
        ownerAccountId: "account_alpha",
        deckVersion: "deck_alpha",
        status: "ACTIVE",
        createdAtMs: 1,
        endedAtMs: null,
        providerToken: "must-not-cross",
      }).success,
    ).toBe(false);
  });

  test("defines a non-authorizing join locator and exact approval identity", () => {
    const join = DisplayJoinSchema.parse({
      displayJoinId: `join_${"1".repeat(32)}`,
      displayId: "display_alpha",
      deckVersion: "deck_alpha",
      displayFingerprint: "stage-fingerprint-alpha",
      expiresAtMs: 90_000,
    });
    expect(Object.keys(join)).not.toContain("authority");
    expect(
      DisplayApprovalSchema.parse({
        presentationSessionId: "ps_alpha",
        displayJoinId: join.displayJoinId,
        expectedDisplayBindingEpoch: "dbe_0",
        expectedDeckVersion: "deck_alpha",
        approvedDisplayId: join.displayId,
        approvedDisplayFingerprint: join.displayFingerprint,
      }),
    ).toBeDefined();
  });
});

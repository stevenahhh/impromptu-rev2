import { describe, expect, test } from "bun:test";
import {
  CreateDisplayInvitationRequestSchema,
  CreateDisplayInvitationResponseSchema,
  DisplayInvitationIdSchema,
  DisplayInvitationIssueRequestSchema,
  DisplayInvitationPendingViewSchema,
  DisplayInvitationTokenSchema,
  DisplayInvitationViewSchema,
  IssuedDisplayInvitationSchema,
  PublicDisplayJoinRequestSchema,
  StoredDisplayInvitationSchema,
} from "./display-invitations.ts";

const invitationId = `dinvite_${"a".repeat(32)}`;
const token = `dinv_${"b".repeat(64)}`;
const digest = "c".repeat(64);
const join = {
  displayJoinId: `join_${"d".repeat(32)}`,
  displayId: "display_alpha",
  deckVersion: "deck_alpha",
  displayFingerprint: "fingerprint-stage-alpha",
  expiresAtMs: 91_000,
};

describe("display invitation contracts", () => {
  test("identifier shapes pin the invitation id and token surfaces", () => {
    expect(DisplayInvitationIdSchema.safeParse(invitationId).success).toBe(true);
    expect(DisplayInvitationIdSchema.safeParse(token).success).toBe(false);
    expect(DisplayInvitationIdSchema.safeParse("join_abc").success).toBe(false);

    expect(DisplayInvitationTokenSchema.safeParse(token).success).toBe(true);
    expect(DisplayInvitationTokenSchema.safeParse(`dinv_${"b".repeat(32)}`).success).toBe(false);
    expect(DisplayInvitationTokenSchema.safeParse(invitationId).success).toBe(false);
    expect(DisplayInvitationTokenSchema.safeParse(42).success).toBe(false);
  });

  test("the internal issuance request is closed over session, deck, and clock", () => {
    const valid = {
      presentationSessionId: "ps_alpha",
      deckVersion: "deck_alpha",
      nowMs: 1_000,
    };
    expect(DisplayInvitationIssueRequestSchema.safeParse(valid).success).toBe(true);
    expect(DisplayInvitationIssueRequestSchema.safeParse({ ...valid, token }).success).toBe(false);
    expect(DisplayInvitationIssueRequestSchema.safeParse({ ...valid, nowMs: "soon" }).success).toBe(
      false,
    );
    expect(
      DisplayInvitationIssueRequestSchema.safeParse({ deckVersion: "deck_alpha", nowMs: 1_000 })
        .success,
    ).toBe(false);
  });

  test("the issued invitation carries the token exactly once and nothing else", () => {
    const issued = {
      invitationId,
      token,
      deckVersion: "deck_alpha",
      expiresAtMs: 91_000,
    };
    const parsed = IssuedDisplayInvitationSchema.safeParse(issued);
    expect(parsed.success).toBe(true);
    expect(IssuedDisplayInvitationSchema.safeParse({ ...issued, join }).success).toBe(false);
    expect(
      IssuedDisplayInvitationSchema.safeParse({
        invitationId,
        deckVersion: "deck_alpha",
        expiresAtMs: 91_000,
      }).success,
    ).toBe(false);
  });

  test("the public join request stays closed and the invitation token is optional", () => {
    const base = {
      displayId: "display_alpha",
      deckVersion: "deck_alpha",
      displayFingerprint: "fingerprint-stage-alpha",
    };
    expect(PublicDisplayJoinRequestSchema.safeParse(base).success).toBe(true);
    expect(
      PublicDisplayJoinRequestSchema.safeParse({ ...base, invitationToken: token }).success,
    ).toBe(true);
    expect(
      PublicDisplayJoinRequestSchema.safeParse({ ...base, invitationToken: "not-a-token" }).success,
    ).toBe(false);
    expect(PublicDisplayJoinRequestSchema.safeParse({ ...base, accountCookie: "x" }).success).toBe(
      false,
    );
    expect(
      PublicDisplayJoinRequestSchema.safeParse({ ...base, displayId: "screen_alpha" }).success,
    ).toBe(false);
  });

  test("the internal view reports status and pending join without the token", () => {
    const pending = {
      invitationId,
      presentationSessionId: "ps_alpha",
      deckVersion: "deck_alpha",
      expiresAtMs: 91_000,
      status: "PENDING",
      join: null,
    };
    expect(DisplayInvitationViewSchema.safeParse(pending).success).toBe(true);
    expect(
      DisplayInvitationViewSchema.safeParse({ ...pending, status: "JOINED", join }).success,
    ).toBe(true);
    expect(DisplayInvitationViewSchema.safeParse({ ...pending, status: "CONSUMED" }).success).toBe(
      false,
    );
    expect(DisplayInvitationViewSchema.safeParse({ ...pending, token }).success).toBe(false);
  });

  test("the stored record keeps only a digest and couples consumption to its join", () => {
    const stored = {
      invitationId,
      tokenDigest: digest,
      presentationSessionId: "ps_alpha",
      deckVersion: "deck_alpha",
      expiresAtMs: 91_000,
      consumedAtMs: null,
      join: null,
    };
    expect(StoredDisplayInvitationSchema.safeParse(stored).success).toBe(true);
    expect(
      StoredDisplayInvitationSchema.safeParse({
        ...stored,
        consumedAtMs: 2_000,
        join,
      }).success,
    ).toBe(true);
    // A consumed stamp without its join (or the reverse) is a corrupt durable record.
    expect(
      StoredDisplayInvitationSchema.safeParse({ ...stored, consumedAtMs: 2_000 }).success,
    ).toBe(false);
    expect(StoredDisplayInvitationSchema.safeParse({ ...stored, join }).success).toBe(false);
    // The digest is the only credential material the store is allowed to hold.
    expect(StoredDisplayInvitationSchema.safeParse({ ...stored, token }).success).toBe(false);
    expect(StoredDisplayInvitationSchema.safeParse({ ...stored, tokenDigest: token }).success).toBe(
      false,
    );
  });

  test("the owner pending view carries the authoritative binding epoch", () => {
    const view = {
      invitationId,
      presentationSessionId: "ps_alpha",
      deckVersion: "deck_alpha",
      expiresAtMs: 91_000,
      status: "JOINED",
      displayBindingEpoch: "dbe_1",
      join,
    };
    expect(DisplayInvitationPendingViewSchema.safeParse(view).success).toBe(true);
    expect(DisplayInvitationPendingViewSchema.safeParse({ ...view, token }).success).toBe(false);
    expect(
      DisplayInvitationPendingViewSchema.safeParse({ ...view, tokenDigest: digest }).success,
    ).toBe(false);
    expect(
      DisplayInvitationPendingViewSchema.safeParse({ ...view, displayBindingEpoch: "three" })
        .success,
    ).toBe(false);
  });

  test("the console create request is closed over the session id", () => {
    expect(
      CreateDisplayInvitationRequestSchema.safeParse({ presentationSessionId: "ps_alpha" }).success,
    ).toBe(true);
    expect(
      CreateDisplayInvitationRequestSchema.safeParse({
        presentationSessionId: "ps_alpha",
        token,
      }).success,
    ).toBe(false);
    expect(CreateDisplayInvitationRequestSchema.safeParse({}).success).toBe(false);
  });

  test("the issuance response pins the token to the URL fragment", () => {
    const response = {
      invitationId,
      token,
      deckVersion: "deck_alpha",
      expiresAtMs: 91_000,
      stagePath: `/?deck=deck_alpha#invite=${token}`,
    };
    expect(CreateDisplayInvitationResponseSchema.safeParse(response).success).toBe(true);
    // A query-string token is exactly the leak the fragment transport exists to prevent.
    expect(
      CreateDisplayInvitationResponseSchema.safeParse({
        ...response,
        stagePath: `/?deck=deck_alpha&invite=${token}`,
      }).success,
    ).toBe(false);
    expect(
      CreateDisplayInvitationResponseSchema.safeParse({
        ...response,
        stagePath: `/?invite=${token}&deck=deck_alpha`,
      }).success,
    ).toBe(false);
  });
});

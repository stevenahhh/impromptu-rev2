import { describe, expect, test } from "bun:test";
import {
  ActorIdSchema,
  CommandIdSchema,
  ControllerEpochSchema,
  ControlRevisionSchema,
  PlaybackControlLeaseIdSchema,
  PlaybackControlLeaseSchema,
} from "@impromptu/contracts/control";
import {
  AccountIdSchema,
  CandidateRevisionSchema,
  CaptureGrantIdSchema,
  CaptureGrantSchema,
  PrivateDeckIdSchema,
  PrivateSlideIdSchema,
  PublicationAuthorityIdSchema,
  PublicationAuthoritySchema,
} from "@impromptu/contracts/private";
import {
  AudienceDisplaySessionIdSchema,
  AudienceDisplaySessionSchema,
  DisplayBindingEpochSchema,
  DisplayBindingIdSchema,
  DisplayBindingSchema,
  PresentationSessionEpochSchema,
  PresentationSessionIdSchema,
  PublicCardRevisionSchema,
  PublicPlaybackRevisionSchema,
} from "@impromptu/contracts/public";

const expiry = 1_800_000_000_000;
const manifestHash = "a".repeat(64);

describe("domain identities", () => {
  test("rejects runtime substitution across ID, epoch, and revision domains", () => {
    const sessionId = PresentationSessionIdSchema.parse("ps_pilot");
    const leaseId = PlaybackControlLeaseIdSchema.parse("lease_primary");
    const authorityId = PublicationAuthorityIdSchema.parse("pubauth_primary");
    const captureGrantId = CaptureGrantIdSchema.parse("capture_primary");
    const bindingId = DisplayBindingIdSchema.parse("binding_stage");
    const audienceId = AudienceDisplaySessionIdSchema.parse("audience_stage");

    expect(PlaybackControlLeaseIdSchema.safeParse(sessionId).success).toBe(false);
    expect(PublicationAuthorityIdSchema.safeParse(leaseId).success).toBe(false);
    expect(CaptureGrantIdSchema.safeParse(authorityId).success).toBe(false);
    expect(DisplayBindingIdSchema.safeParse(captureGrantId).success).toBe(false);
    expect(AudienceDisplaySessionIdSchema.safeParse(bindingId).success).toBe(false);
    expect(PresentationSessionIdSchema.safeParse(audienceId).success).toBe(false);

    const sessionEpoch = PresentationSessionEpochSchema.parse("pse_3");
    const controllerEpoch = ControllerEpochSchema.parse("ce_3");
    const bindingEpoch = DisplayBindingEpochSchema.parse("dbe_3");
    expect(ControllerEpochSchema.safeParse(sessionEpoch).success).toBe(false);
    expect(DisplayBindingEpochSchema.safeParse(controllerEpoch).success).toBe(false);
    expect(PresentationSessionEpochSchema.safeParse(bindingEpoch).success).toBe(false);

    const controlRevision = ControlRevisionSchema.parse("cr_8");
    const playbackRevision = PublicPlaybackRevisionSchema.parse("pbr_8");
    const cardRevision = PublicCardRevisionSchema.parse("pcr_8");
    expect(PublicPlaybackRevisionSchema.safeParse(controlRevision).success).toBe(false);
    expect(PublicCardRevisionSchema.safeParse(playbackRevision).success).toBe(false);
    expect(ControlRevisionSchema.safeParse(cardRevision).success).toBe(false);
  });

  test("rejects counters above Number.MAX_SAFE_INTEGER without throwing", () => {
    const oversized = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    for (const [schema, value] of [
      [PresentationSessionEpochSchema, `pse_${oversized}`],
      [ControllerEpochSchema, `ce_${oversized}`],
      [DisplayBindingEpochSchema, `dbe_${oversized}`],
      [ControlRevisionSchema, `cr_${oversized}`],
      [PublicPlaybackRevisionSchema, `pbr_${oversized}`],
      [PublicCardRevisionSchema, `pcr_${oversized}`],
      [CandidateRevisionSchema, `candrev_${oversized}`],
    ] as const) {
      expect(() => schema.safeParse(value)).not.toThrow();
      expect(schema.safeParse(value).success).toBe(false);
    }
    const overlong = `pcr_1${"0".repeat(100_000)}`;
    expect(() => PublicCardRevisionSchema.safeParse(overlong)).not.toThrow();
    expect(PublicCardRevisionSchema.safeParse(overlong).success).toBe(false);
  });

  test("parses non-interchangeable lease and capability contracts", () => {
    const lease = PlaybackControlLeaseSchema.parse({
      leaseId: "lease_primary",
      presentationSessionId: "ps_pilot",
      presentationSessionEpoch: "pse_3",
      actorId: "actor_controller",
      controllerEpoch: "ce_6",
      expiresAtMs: expiry,
    });
    const authority = PublicationAuthoritySchema.parse({
      authorityId: "pubauth_primary",
      presentationSessionId: "ps_pilot",
      presentationSessionEpoch: "pse_3",
      actorId: "actor_publisher",
      policyVersion: "policy-v2",
      expiresAtMs: expiry,
    });
    const captureGrant = CaptureGrantSchema.parse({
      captureGrantId: "capture_primary",
      presentationSessionId: "ps_pilot",
      presentationSessionEpoch: "pse_3",
      actorId: "actor_capture",
      captureDeviceId: "device_microphone",
      consentRecordId: "consent_record",
      issuedAtMs: 1_000,
      expiresAtMs: expiry,
    });
    const binding = DisplayBindingSchema.parse({
      displayBindingId: "binding_stage",
      presentationSessionId: "ps_pilot",
      presentationSessionEpoch: "pse_3",
      displayId: "display_stage",
      displayBindingEpoch: "dbe_4",
      deckVersion: "deck_v7",
      manifestHash,
    });
    const audience = AudienceDisplaySessionSchema.parse({
      audienceDisplaySessionId: "audience_stage",
      binding,
      expiresAtMs: expiry,
    });

    expect(PublicationAuthoritySchema.safeParse(lease).success).toBe(false);
    expect(CaptureGrantSchema.safeParse(authority).success).toBe(false);
    expect(DisplayBindingSchema.safeParse(captureGrant).success).toBe(false);
    expect(AudienceDisplaySessionSchema.safeParse(binding).success).toBe(false);
    expect(audience.binding).toEqual(binding);
  });

  test("brands deck, slide, account, actor, and command identifiers independently", () => {
    const deck = PrivateDeckIdSchema.parse("private_deck_1");
    const slide = PrivateSlideIdSchema.parse("private_slide_1");
    const account = AccountIdSchema.parse("account_owner");
    expect(PrivateSlideIdSchema.safeParse(deck).success).toBe(false);
    expect(AccountIdSchema.safeParse(slide).success).toBe(false);
    expect(PrivateDeckIdSchema.safeParse(account).success).toBe(false);

    const actor = ActorIdSchema.parse("actor_controller");
    const command = CommandIdSchema.parse("cmd_next");
    expect(CommandIdSchema.safeParse(actor).success).toBe(false);
    expect(ActorIdSchema.safeParse(command).success).toBe(false);
  });
});

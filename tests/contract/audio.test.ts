import { describe, expect, test } from "bun:test";
import {
  AudioCaptureConsentSchema,
  CaptureGrantSchema,
  DeviceClockReferenceSchema,
  TimedTranscriptSchema,
} from "@impromptu/contracts/private";

const notice = {
  purpose: "실시간 자막 및 슬라이드 귀속",
  vendors: ["bakeoff-selected-provider"],
  region: "kr-central",
  retention: "Raw samples remain in memory for at most 30 seconds and are never stored.",
  deletion: "The provider stream is deleted when capture ends.",
} as const;

describe("audio contracts", () => {
  test("requires an explicit, purpose-bound consent record for a short-lived session grant", () => {
    const consent = AudioCaptureConsentSchema.parse({
      consentRecordId: "consent_alpha",
      presentationSessionId: "ps_alpha",
      presentationSessionEpoch: "pse_1",
      actorId: "actor_alpha",
      captureDeviceId: "device_microphone",
      notice,
      explicitlyAccepted: true,
      acceptedAtMs: 1_000,
    });
    const grant = CaptureGrantSchema.parse({
      captureGrantId: "capture_alpha",
      presentationSessionId: consent.presentationSessionId,
      presentationSessionEpoch: consent.presentationSessionEpoch,
      actorId: consent.actorId,
      captureDeviceId: consent.captureDeviceId,
      consentRecordId: consent.consentRecordId,
      issuedAtMs: 1_000,
      expiresAtMs: 61_000,
    });

    expect(grant.expiresAtMs - grant.issuedAtMs).toBe(60_000);
    expect(
      AudioCaptureConsentSchema.safeParse({ ...consent, explicitlyAccepted: false }).success,
    ).toBe(false);
    expect(CaptureGrantSchema.safeParse({ ...grant, expiresAtMs: 1_000 }).success).toBe(false);
  });

  test("types device clock references and final word timing without unknown fields", () => {
    const clock = DeviceClockReferenceSchema.parse({
      mappingVersion: "clock-v1",
      presentationSessionId: "ps_alpha",
      presentationSessionEpoch: "pse_1",
      deviceId: "device_microphone",
      anchorDeviceMs: 10_000,
      anchorSessionMs: 10_125,
      uncertaintyMs: 12,
      validFromDeviceMs: 9_000,
      validUntilDeviceMs: 20_000,
    });
    const transcript = TimedTranscriptSchema.parse({
      transcriptFinalId: "transcript_alpha",
      language: "ko-KR",
      text: "안녕하세요",
      audioStartDeviceMs: 11_000,
      audioEndDeviceMs: 11_400,
      clock,
      words: [{ text: "안녕하세요", startDeviceMs: 11_020, endDeviceMs: 11_380 }],
    });

    expect(transcript.clock.anchorSessionMs - transcript.clock.anchorDeviceMs).toBe(125);
    expect(TimedTranscriptSchema.safeParse({ ...transcript, provider: "forbidden" }).success).toBe(
      false,
    );
  });
});

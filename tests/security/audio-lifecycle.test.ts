import { describe, expect, test } from "bun:test";
import { AudioCaptureConsentSchema, TimedTranscriptSchema } from "@impromptu/contracts/private";
import { fuseTranscriptToSlide } from "@impromptu/state";
import {
  createTrustedModelContext,
  type DeadlineScheduler,
  type ModelDispatchRequest,
  ModelRoutingRegistry,
  type PolicyVersionAuthority,
  ServerModelRouter,
  StaticExactEgressPolicy,
  type TenantBudget,
  type TenantQuotaPolicy,
  type TrustedModelContext,
} from "../../services/model-router/src/index.ts";
import { createScriptedSttAdapter } from "../../services/model-router/src/testing.ts";
import {
  AudioCaptureCoordinator,
  RouterBackedAudioSttPort,
} from "../../services/private-backend/src/audio-capture.ts";

class ManualScheduler implements DeadlineScheduler {
  nowMs = 1_000;
  now = () => this.nowMs;
  schedule(_atMs: number, _run: () => void) {
    return () => undefined;
  }
}

class Gates implements PolicyVersionAuthority, TenantQuotaPolicy, TenantBudget {
  async assertCurrent(_request: ModelDispatchRequest, _context: TrustedModelContext) {}
  async assertWithinQuota(_request: ModelDispatchRequest, _context: TrustedModelContext) {}
  async reserve(request: ModelDispatchRequest, _context: TrustedModelContext) {
    return { reservationId: "audio-security", reservedUnits: request.estimatedCostUnits };
  }
  async reconcile() {}
}

function consent() {
  return AudioCaptureConsentSchema.parse({
    consentRecordId: "consent_security",
    presentationSessionId: "ps_security",
    presentationSessionEpoch: "pse_1",
    actorId: "actor_security",
    captureDeviceId: "device_security",
    notice: {
      purpose: "Korean transcription",
      vendors: ["selected-provider"],
      region: "kr-central",
      retention: "memory only <=30s",
      deletion: "stream close",
    },
    explicitlyAccepted: true,
    acceptedAtMs: 1_000,
  });
}

function system(requirement = false) {
  const time = new ManualScheduler();
  const gates = new Gates();
  const registry = new ModelRoutingRegistry();
  const transcript = { text: "보안 검증", language: "ko-KR", durationMs: 100 };
  registry.registerDeterministicFakeStreamingStt(
    createScriptedSttAdapter({
      transcript,
      events: [{ kind: "final", sequence: 0, transcript }],
      ...(requirement
        ? {
            requirement: {
              secretId: "fixture/audio-security",
              egressOrigin: "https://blocked.vendor.invalid",
            },
          }
        : {}),
    }),
  );
  const router = new ServerModelRouter({
    registry,
    clock: time.now,
    scheduler: time,
    policyVersionAuthority: gates,
    quotaPolicy: gates,
    budget: gates,
    egressPolicy: new StaticExactEgressPolicy([
      {
        adapterId: "deterministic-fake-stt",
        origin: "https://allowed.vendor.invalid",
      },
    ]),
    secretStore: {
      async read() {
        return { value: "fixture" };
      },
    },
    providerTransport: {
      async send() {
        return { status: 200, headers: {}, body: new Uint8Array() };
      },
    },
  });
  const port = new RouterBackedAudioSttPort(router, (signal) =>
    createTrustedModelContext({
      tenantId: "tenant-security",
      principalId: "actor-security",
      requestId: "request-security",
      traceId: "trace-security",
      policyVersion: "policy-security",
      deadlineAtMs: 2_000,
      signal,
    }),
  );
  let id = 0;
  return new AudioCaptureCoordinator(port, { createGrantId: () => `capture_${++id}` });
}

describe("audio lifecycle security", () => {
  test("no consent, revoke, cancellation, and denied egress terminate without buffered samples", async () => {
    const denied = system(true);
    expect(denied.pushFrame("capture_missing", 0, new Uint8Array([7]), 10, 1_001)).toEqual({
      outcome: "REJECTED",
      reason: "CONSENT_REQUIRED",
    });
    const deniedGrant = denied.issueGrant(consent(), 1_000);
    expect(
      await denied.startCapture(
        deniedGrant.captureGrantId,
        {
          actorId: deniedGrant.actorId,
          presentationSessionId: deniedGrant.presentationSessionId,
          presentationSessionEpoch: deniedGrant.presentationSessionEpoch,
        },
        1_001,
      ),
    ).toEqual({
      outcome: "MODEL_POLICY_DENIED",
    });
    expect(denied.bufferedBytes(deniedGrant.captureGrantId)).toBe(0);

    const cancelled = system();
    const grant = cancelled.issueGrant(consent(), 1_000);
    const terminal = cancelled.startCapture(
      grant.captureGrantId,
      {
        actorId: grant.actorId,
        presentationSessionId: grant.presentationSessionId,
        presentationSessionEpoch: grant.presentationSessionEpoch,
      },
      1_001,
    );
    cancelled.pushFrame(grant.captureGrantId, 0, new Uint8Array([1, 2, 3]), 10, 1_002);
    cancelled.revokeGrant(grant.captureGrantId, 1_003);
    expect(await terminal).toEqual({ outcome: "GRANT_REVOKED" });
    expect(cancelled.bufferedBytes(grant.captureGrantId)).toBe(0);
  });

  test("spoofed device timestamps abstain rather than attaching speech to a slide", () => {
    const transcript = TimedTranscriptSchema.parse({
      transcriptFinalId: "transcript_security",
      language: "ko-KR",
      text: "위조 시각",
      audioStartDeviceMs: 50_000,
      audioEndDeviceMs: 50_100,
      clock: {
        mappingVersion: "clock-security",
        presentationSessionId: "ps_security",
        presentationSessionEpoch: "pse_1",
        deviceId: "device_security",
        anchorDeviceMs: 1_000,
        anchorSessionMs: 1_020,
        uncertaintyMs: 5,
        validFromDeviceMs: 900,
        validUntilDeviceMs: 2_000,
      },
      words: [{ text: "위조", startDeviceMs: 50_000, endDeviceMs: 50_100 }],
    });
    expect(
      fuseTranscriptToSlide(transcript, [], {
        clockAuthority: {
          presentationSessionId: "ps_security",
          presentationSessionEpoch: "pse_1",
          mappingVersion: "clock-security",
          deviceId: "device_security",
          anchorDeviceMs: 1_000,
          anchorSessionMs: 1_020,
          maxClockOffsetMs: 100,
        },
      }),
    ).toEqual({
      outcome: "AMBIGUOUS",
      reason: "CLOCK_REFERENCE_OUT_OF_RANGE",
    });
  });
});

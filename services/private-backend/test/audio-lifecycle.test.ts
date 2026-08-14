import { describe, expect, test } from "bun:test";
import type { AudioCaptureConsent } from "@impromptu/contracts/private";
import {
  AudioCaptureCoordinator,
  AudioSttPortError,
  type AudioStreamTerminal,
  RouterBackedAudioSttPort,
  type ServerAudioSttPort,
} from "../src/audio-capture.ts";

class FakeSttPort implements ServerAudioSttPort {
  readonly received: number[] = [];
  signal: AbortSignal | undefined;
  fail = false;

  async transcribe(chunks: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    this.signal = signal;
    for await (const chunk of chunks) this.received.push(...chunk);
    if (this.fail) throw new Error("provider unavailable");
    return { text: "확정", language: "ko-KR", durationMs: 20 };
  }
}

function consent(overrides: Partial<AudioCaptureConsent> = {}): AudioCaptureConsent {
  return {
    consentRecordId: "consent_alpha" as AudioCaptureConsent["consentRecordId"],
    presentationSessionId: "ps_alpha" as AudioCaptureConsent["presentationSessionId"],
    presentationSessionEpoch: "pse_1" as AudioCaptureConsent["presentationSessionEpoch"],
    actorId: "actor_alpha" as AudioCaptureConsent["actorId"],
    captureDeviceId: "device_microphone" as AudioCaptureConsent["captureDeviceId"],
    notice: {
      purpose: "실시간 자막",
      vendors: ["selected-provider"],
      region: "kr-central",
      retention: "30 seconds in memory; no durable storage",
      deletion: "delete when stream closes",
    },
    explicitlyAccepted: true,
    acceptedAtMs: 1_000,
    ...overrides,
  };
}

function capture(port = new FakeSttPort()) {
  let id = 0;
  return {
    port,
    coordinator: new AudioCaptureCoordinator(port, {
      grantTtlMs: 60_000,
      createGrantId: () => `capture_${++id}`,
    }),
  };
}

describe("model-router audio streaming port", () => {
  test("sequences chunks through the server boundary and preserves typed failure", async () => {
    const seen: number[] = [];
    const boundary = {
      async *streamStt(chunks: AsyncIterable<{ sequence: number; audio: Uint8Array }>) {
        for await (const chunk of chunks) seen.push(chunk.sequence);
        yield { kind: "complete" as const, result: { ok: false as const, error: { code: "policy_denied" } } };
      },
    };
    const port = new RouterBackedAudioSttPort(boundary, (signal) => ({ signal }));
    async function* chunks() {
      yield new Uint8Array([1]);
      yield new Uint8Array([2]);
    }

    const result = port.transcribe(chunks(), new AbortController().signal);
    await expect(result).rejects.toBeInstanceOf(AudioSttPortError);
    try {
      await result;
    } catch (caught) {
      expect((caught as AudioSttPortError).code).toBe("policy_denied");
    }
    expect(seen).toEqual([0, 1]);
  });
});

describe("audio consent and capture lifecycle", () => {
  test("rejects every frame before explicit consent and starts only with a matching grant", async () => {
    const { coordinator, port } = capture();
    expect(coordinator.pushFrame("capture_missing", 0, new Uint8Array([1]), 10, 1_001)).toEqual({
      outcome: "REJECTED",
      reason: "CONSENT_REQUIRED",
    });

    const grant = coordinator.issueGrant(consent(), 1_000);
    const terminal = coordinator.startCapture(grant.captureGrantId, consent().actorId, 1_001);
    expect(coordinator.pushFrame(grant.captureGrantId, 0, new Uint8Array([1, 2]), 10, 1_002)).toEqual({
      outcome: "ACCEPTED",
    });
    expect(coordinator.stopCapture(grant.captureGrantId, 1_003)).toEqual({ outcome: "STOPPED" });

    expect(await terminal).toEqual({
      outcome: "COMPLETED",
      transcript: { text: "확정", language: "ko-KR", durationMs: 20 },
    });
    expect(port.received).toEqual([1, 2]);
  });

  test("revocation aborts capture and rejects the next frame deterministically", async () => {
    const { coordinator, port } = capture();
    const grant = coordinator.issueGrant(consent(), 1_000);
    const terminal = coordinator.startCapture(grant.captureGrantId, consent().actorId, 1_001);
    coordinator.pushFrame(grant.captureGrantId, 0, new Uint8Array([1]), 10, 1_002);

    expect(coordinator.revokeGrant(grant.captureGrantId, 1_003)).toEqual({ outcome: "REVOKED" });
    expect(coordinator.pushFrame(grant.captureGrantId, 1, new Uint8Array([2]), 10, 1_004)).toEqual({
      outcome: "REJECTED",
      reason: "GRANT_REVOKED",
    });
    expect(await terminal).toEqual({ outcome: "GRANT_REVOKED" });
    expect(port.signal?.aborted).toBe(true);
    expect(coordinator.bufferedBytes(grant.captureGrantId)).toBe(0);
  });

  test("expiry, logout, session end, cancellation, and provider failure are typed terminals", async () => {
    const outcomes: AudioStreamTerminal[] = [];
    for (const action of ["expiry", "logout", "session", "cancel", "provider"] as const) {
      const { coordinator, port } = capture();
      const grant = coordinator.issueGrant(consent(), 1_000);
      if (action === "provider") port.fail = true;
      const terminal = coordinator.startCapture(grant.captureGrantId, consent().actorId, 1_001);
      if (action === "expiry") coordinator.expireGrants(61_000);
      if (action === "logout") coordinator.actorLoggedOut(consent().actorId, 1_002);
      if (action === "session") coordinator.sessionEnded(consent().presentationSessionId, 1_002);
      if (action === "cancel") coordinator.cancelStream(grant.captureGrantId, 1_002);
      if (action === "provider") coordinator.stopCapture(grant.captureGrantId, 1_002);
      outcomes.push(await terminal);
      expect(coordinator.bufferedBytes(grant.captureGrantId)).toBe(0);
    }
    expect(outcomes.map((value) => value.outcome)).toEqual([
      "GRANT_EXPIRED",
      "ACTOR_LOGOUT",
      "SESSION_ENDED",
      "STREAM_CANCELLED",
      "PROVIDER_FAILURE",
    ]);
  });

  test("rejects sequence replay and more than 30 seconds of queued samples", () => {
    const { coordinator } = capture();
    const grant = coordinator.issueGrant(consent(), 1_000);
    void coordinator.startCapture(grant.captureGrantId, consent().actorId, 1_001);
    expect(coordinator.pushFrame(grant.captureGrantId, 1, new Uint8Array([1]), 1, 1_002)).toEqual({
      outcome: "REJECTED",
      reason: "INVALID_SEQUENCE",
    });
    expect(
      coordinator.pushFrame(grant.captureGrantId, 0, new Uint8Array([1]), 30_001, 1_002),
    ).toEqual({ outcome: "REJECTED", reason: "BUFFER_LIMIT_EXCEEDED" });
    coordinator.cancelStream(grant.captureGrantId, 1_003);
  });
});

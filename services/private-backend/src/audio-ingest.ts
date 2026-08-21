import { STT_AUDIO_MIME_TYPE, SttStreamEventSchema } from "@impromptu/contracts/private";
import {
  AudioCaptureCoordinator,
  type AudioStreamTerminal,
  RouterBackedAudioSttPort,
  type StreamingSttRouterBoundary,
} from "./audio-capture.ts";

export const AUDIO_CAPTURE_COOKIE_NAME = "__Host-capture";
export const MAX_AUDIO_FRAME_BYTES = 1_048_576;

export type AudioCaptureIdentity = Readonly<{
  accountId: string;
  actorId: string;
  presentationSessionId: string;
  presentationSessionEpoch: string;
}>;

export type AudioGrantRequest = Readonly<{
  mimeType: typeof STT_AUDIO_MIME_TYPE;
  consent: unknown;
}>;

export type AudioIngestEvent =
  | Readonly<{ kind: "READY" }>
  | Readonly<{ kind: "TRANSCRIPT"; event: unknown }>
  | Readonly<{ kind: "TERMINAL"; outcome: AudioStreamTerminal["outcome"] }>;

export type AudioGrantIssueResult =
  | Readonly<{ outcome: "ISSUED"; expiresAtMs: number; grantId: string }>
  | Readonly<{ outcome: "REJECTED"; reason: "ACTOR_MISMATCH" | "INVALID_REQUEST" }>;

export type AudioGrantAccessResult =
  | Readonly<{ outcome: "ALLOWED" }>
  | Readonly<{
      outcome: "REJECTED";
      reason:
        | "CAPTURE_GRANT_REQUIRED"
        | "GRANT_EXPIRED"
        | "GRANT_REPLAYED"
        | "GRANT_REVOKED"
        | "GRANT_SESSION_MISMATCH"
        | "STREAM_NOT_ACTIVE";
    }>;

export interface AudioIngestService {
  issueGrant(
    accountSessionId: string,
    accountId: string,
    accountActorId: string,
    request: unknown,
    nowMs: number,
  ): AudioGrantIssueResult;
  openEvents(
    accountSessionId: string,
    grantId: string,
    nowMs: number,
  ):
    | Readonly<{ outcome: "OPENED"; stream: ReadableStream<Uint8Array> }>
    | Readonly<{ outcome: "REJECTED"; reason: string }>;
  startStream(
    accountSessionId: string,
    grantId: string,
    nowMs: number,
  ): Readonly<{ outcome: "STARTED" }> | Readonly<{ outcome: "REJECTED"; reason: string }>;
  authorizeFrame(accountSessionId: string, grantId: string, nowMs: number): AudioGrantAccessResult;
  pushFrame(
    accountSessionId: string,
    grantId: string,
    sequence: number,
    frame: Uint8Array,
    durationMs: number,
    nowMs: number,
  ): Readonly<{ outcome: "ACCEPTED" }> | Readonly<{ outcome: "REJECTED"; reason: string }>;
  stopStream(
    accountSessionId: string,
    grantId: string,
    nowMs: number,
  ): Readonly<{ outcome: "STOPPED" }> | Readonly<{ outcome: "REJECTED"; reason: string }>;
  revokeGrant(
    accountSessionId: string,
    grantId: string,
    nowMs: number,
  ): Readonly<{ outcome: "REVOKED" }> | Readonly<{ outcome: "REJECTED"; reason: string }>;
  accountLoggedOut(accountSessionId: string, actorId: string, nowMs: number): void;
  sessionEnded(presentationSessionId: string, nowMs: number): void;
}

export interface AudioIngestServiceOptions {
  readonly router: StreamingSttRouterBoundary;
  readonly contextFor: (identity: AudioCaptureIdentity, signal: AbortSignal) => unknown;
  readonly adapterId?: string;
  readonly grantTtlMs?: number;
  readonly createGrantId: () => string;
}

type GrantState = "ACTIVE" | "STARTED" | "STOPPING" | "CONSUMED" | "EXPIRED" | "REVOKED";

type GrantBinding = {
  readonly accountSessionId: string;
  readonly identity: AudioCaptureIdentity;
  readonly expiresAtMs: number;
  state: GrantState;
  eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  eventsOpened: boolean;
};

type PendingTranscription = Readonly<{ grantId: string; identity: AudioCaptureIdentity }>;

const encoder = new TextEncoder();

class EventForwardingAudioSttPort {
  #pending: PendingTranscription | undefined;

  constructor(
    private readonly router: StreamingSttRouterBoundary,
    private readonly contextFor: AudioIngestServiceOptions["contextFor"],
    private readonly publishTranscript: (grantId: string, event: unknown) => void,
    private readonly adapterId?: string,
  ) {}

  bindNext(grantId: string, identity: AudioCaptureIdentity): void {
    if (this.#pending !== undefined) throw new Error("audio transcription binding already pending");
    this.#pending = { grantId, identity };
  }

  async transcribe(chunks: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending === undefined) throw new Error("audio transcription binding is missing");

    const forwardingBoundary: StreamingSttRouterBoundary = {
      streamStt: (sequencedChunks, context, adapterId) =>
        this.#forward(pending.grantId, sequencedChunks, context, adapterId),
    };
    const port = new RouterBackedAudioSttPort(
      forwardingBoundary,
      (boundSignal) => this.contextFor(pending.identity, boundSignal),
      this.adapterId,
    );
    return await port.transcribe(chunks, signal);
  }

  async *#forward(
    grantId: string,
    chunks: AsyncIterable<Readonly<{ sequence: number; audio: Uint8Array }>>,
    context: unknown,
    adapterId?: string,
  ): ReturnType<StreamingSttRouterBoundary["streamStt"]> {
    for await (const item of this.router.streamStt(chunks, context, adapterId)) {
      if (item.kind === "transcript") {
        this.publishTranscript(grantId, SttStreamEventSchema.parse(item.event));
      }
      yield item;
    }
  }
}

class DefaultAudioIngestService implements AudioIngestService {
  readonly #coordinator: AudioCaptureCoordinator;
  readonly #port: EventForwardingAudioSttPort;
  readonly #bindings = new Map<string, GrantBinding>();

  constructor(options: AudioIngestServiceOptions) {
    this.#port = new EventForwardingAudioSttPort(
      options.router,
      options.contextFor,
      (grantId, event) => this.#publish(grantId, { kind: "TRANSCRIPT", event }),
      options.adapterId,
    );
    this.#coordinator = new AudioCaptureCoordinator(this.#port, {
      createGrantId: options.createGrantId,
      ...(options.grantTtlMs === undefined ? {} : { grantTtlMs: options.grantTtlMs }),
    });
  }

  issueGrant(
    accountSessionId: string,
    accountId: string,
    accountActorId: string,
    request: unknown,
    nowMs: number,
  ): AudioGrantIssueResult {
    if (
      !isRecord(request) ||
      Object.keys(request).length !== 2 ||
      request.mimeType !== STT_AUDIO_MIME_TYPE ||
      !("consent" in request) ||
      !isRecord(request.consent)
    ) {
      return { outcome: "REJECTED", reason: "INVALID_REQUEST" };
    }
    if (request.consent.actorId !== accountActorId) {
      return { outcome: "REJECTED", reason: "ACTOR_MISMATCH" };
    }

    let grant: ReturnType<AudioCaptureCoordinator["issueGrant"]>;
    try {
      grant = this.#coordinator.issueGrant(request.consent, nowMs);
    } catch {
      return { outcome: "REJECTED", reason: "INVALID_REQUEST" };
    }

    for (const [grantId, binding] of this.#bindings) {
      if (
        binding.state !== "REVOKED" &&
        binding.state !== "CONSUMED" &&
        binding.state !== "EXPIRED" &&
        binding.identity.actorId === grant.actorId &&
        (binding.identity.presentationSessionId !== grant.presentationSessionId ||
          binding.identity.presentationSessionEpoch !== grant.presentationSessionEpoch)
      ) {
        binding.state = "REVOKED";
        this.#publish(grantId, { kind: "TERMINAL", outcome: "GRANT_REVOKED" });
      }
    }

    this.#bindings.set(grant.captureGrantId, {
      accountSessionId,
      identity: {
        accountId,
        actorId: grant.actorId,
        presentationSessionId: grant.presentationSessionId,
        presentationSessionEpoch: grant.presentationSessionEpoch,
      },
      expiresAtMs: grant.expiresAtMs,
      state: "ACTIVE",
      eventController: undefined,
      eventsOpened: false,
    });
    return { outcome: "ISSUED", expiresAtMs: grant.expiresAtMs, grantId: grant.captureGrantId };
  }

  openEvents(accountSessionId: string, grantId: string, nowMs: number) {
    const access = this.#access(accountSessionId, grantId, nowMs, false);
    if (access.outcome === "REJECTED") return access;
    const binding = this.#bindings.get(grantId);
    if (binding === undefined)
      return { outcome: "REJECTED" as const, reason: "CAPTURE_GRANT_REQUIRED" };
    if (binding.eventsOpened)
      return { outcome: "REJECTED" as const, reason: "EVENTS_ALREADY_OPEN" };
    binding.eventsOpened = true;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        binding.eventController = controller;
        controller.enqueue(encodeEvent({ kind: "READY" }));
      },
      cancel: () => {
        binding.eventController = undefined;
        if (binding.state === "STARTED" || binding.state === "STOPPING") {
          this.#coordinator.cancelStream(grantId, nowMs);
          binding.state = "CONSUMED";
        } else if (binding.state === "ACTIVE") {
          this.#coordinator.revokeGrant(grantId, nowMs);
          binding.state = "REVOKED";
        }
      },
    });
    return { outcome: "OPENED" as const, stream };
  }

  startStream(accountSessionId: string, grantId: string, nowMs: number) {
    const access = this.#access(accountSessionId, grantId, nowMs, false);
    if (access.outcome === "REJECTED") return access;
    const binding = this.#bindings.get(grantId);
    if (binding === undefined)
      return { outcome: "REJECTED" as const, reason: "CAPTURE_GRANT_REQUIRED" };
    if (binding.state !== "ACTIVE") {
      return { outcome: "REJECTED" as const, reason: "GRANT_REPLAYED" };
    }

    binding.state = "STARTED";
    this.#port.bindNext(grantId, binding.identity);
    const terminal = this.#coordinator.startCapture(grantId, binding.identity, nowMs);
    void terminal.then((result) => {
      if (result.outcome === "GRANT_EXPIRED") binding.state = "EXPIRED";
      else if (
        result.outcome === "GRANT_REVOKED" ||
        result.outcome === "ACTOR_LOGOUT" ||
        result.outcome === "SESSION_ENDED"
      ) {
        binding.state = "REVOKED";
      } else {
        binding.state = "CONSUMED";
      }
      this.#publish(grantId, { kind: "TERMINAL", outcome: result.outcome });
    });
    return { outcome: "STARTED" as const };
  }

  authorizeFrame(accountSessionId: string, grantId: string, nowMs: number): AudioGrantAccessResult {
    return this.#access(accountSessionId, grantId, nowMs, true);
  }

  pushFrame(
    accountSessionId: string,
    grantId: string,
    sequence: number,
    frame: Uint8Array,
    durationMs: number,
    nowMs: number,
  ) {
    const access = this.#access(accountSessionId, grantId, nowMs, true);
    if (access.outcome === "REJECTED") return access;
    return this.#coordinator.pushFrame(grantId, sequence, frame, durationMs, nowMs);
  }

  stopStream(accountSessionId: string, grantId: string, nowMs: number) {
    const access = this.#access(accountSessionId, grantId, nowMs, true);
    if (access.outcome === "REJECTED") return access;
    const stopped = this.#coordinator.stopCapture(grantId, nowMs);
    if (stopped.outcome === "NOT_ACTIVE") {
      return { outcome: "REJECTED", reason: "STREAM_NOT_ACTIVE" } as const;
    }
    const binding = this.#bindings.get(grantId);
    if (binding !== undefined) binding.state = "STOPPING";
    return { outcome: "STOPPED" } as const;
  }

  revokeGrant(accountSessionId: string, grantId: string, nowMs: number) {
    const access = this.#access(accountSessionId, grantId, nowMs, false);
    if (access.outcome === "REJECTED") return access;
    const binding = this.#bindings.get(grantId);
    if (binding === undefined)
      return { outcome: "REJECTED" as const, reason: "CAPTURE_GRANT_REQUIRED" };
    binding.state = "REVOKED";
    const revoked = this.#coordinator.revokeGrant(grantId, nowMs);
    if (revoked.outcome === "NOT_FOUND") {
      return { outcome: "REJECTED" as const, reason: "CAPTURE_GRANT_REQUIRED" };
    }
    this.#publish(grantId, { kind: "TERMINAL", outcome: "GRANT_REVOKED" });
    return { outcome: "REVOKED" as const };
  }

  accountLoggedOut(accountSessionId: string, actorId: string, nowMs: number): void {
    this.#coordinator.actorLoggedOut(actorId, nowMs);
    for (const [grantId, binding] of this.#bindings) {
      if (binding.accountSessionId !== accountSessionId) continue;
      binding.state = "REVOKED";
      this.#publish(grantId, { kind: "TERMINAL", outcome: "ACTOR_LOGOUT" });
    }
  }

  sessionEnded(presentationSessionId: string, nowMs: number): void {
    this.#coordinator.sessionEnded(presentationSessionId, nowMs);
    for (const [grantId, binding] of this.#bindings) {
      if (binding.identity.presentationSessionId !== presentationSessionId) continue;
      binding.state = "REVOKED";
      this.#publish(grantId, { kind: "TERMINAL", outcome: "SESSION_ENDED" });
    }
  }

  #access(
    accountSessionId: string,
    grantId: string,
    nowMs: number,
    requireStarted: boolean,
  ): AudioGrantAccessResult {
    const binding = this.#bindings.get(grantId);
    if (binding === undefined) {
      return { outcome: "REJECTED", reason: "CAPTURE_GRANT_REQUIRED" };
    }
    if (binding.accountSessionId !== accountSessionId) {
      return { outcome: "REJECTED", reason: "GRANT_SESSION_MISMATCH" };
    }
    if (nowMs >= binding.expiresAtMs) {
      this.#coordinator.expireGrants(nowMs);
      binding.state = "EXPIRED";
      this.#publish(grantId, { kind: "TERMINAL", outcome: "GRANT_EXPIRED" });
      return { outcome: "REJECTED", reason: "GRANT_EXPIRED" };
    }
    if (binding.state === "EXPIRED") return { outcome: "REJECTED", reason: "GRANT_EXPIRED" };
    if (binding.state === "REVOKED") return { outcome: "REJECTED", reason: "GRANT_REVOKED" };
    if (binding.state === "CONSUMED") {
      return {
        outcome: "REJECTED",
        reason: requireStarted ? "STREAM_NOT_ACTIVE" : "GRANT_REPLAYED",
      };
    }
    if (requireStarted && binding.state !== "STARTED") {
      return { outcome: "REJECTED", reason: "STREAM_NOT_ACTIVE" };
    }
    return { outcome: "ALLOWED" };
  }

  #publish(grantId: string, event: AudioIngestEvent): void {
    const binding = this.#bindings.get(grantId);
    const controller = binding?.eventController;
    if (binding === undefined || controller === undefined) return;
    controller.enqueue(encodeEvent(event));
    if (event.kind === "TERMINAL") {
      binding.eventController = undefined;
      controller.close();
    }
  }
}

export function createAudioIngestService(options: AudioIngestServiceOptions): AudioIngestService {
  return new DefaultAudioIngestService(options);
}

function encodeEvent(event: AudioIngestEvent): Uint8Array {
  return encoder.encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

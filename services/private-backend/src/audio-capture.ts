import {
  AudioCaptureConsentSchema,
  type CaptureGrant,
  CaptureGrantSchema,
} from "@impromptu/contracts/private";

export interface ServerAudioSttPort {
  transcribe(
    chunks: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<Readonly<{ text: string; language: string; durationMs: number }>>;
}

export interface StreamingSttRouterBoundary {
  streamStt(
    chunks: AsyncIterable<Readonly<{ sequence: number; audio: Uint8Array }>>,
    context: unknown,
    adapterId?: string,
  ): AsyncIterable<
    | Readonly<{ kind: "transcript"; event: unknown }>
    | Readonly<{
        kind: "complete";
        result:
          | Readonly<{
              ok: true;
              output: Readonly<{ text: string; language: string; durationMs: number }>;
            }>
          | Readonly<{ ok: false; error: Readonly<{ code: string }> }>;
      }>
  >;
}

export class AudioSttPortError extends Error {
  constructor(readonly code: string) {
    super(`Server model router ended audio transcription: ${code}`);
    this.name = "AudioSttPortError";
  }
}

export class RouterBackedAudioSttPort implements ServerAudioSttPort {
  constructor(
    readonly router: StreamingSttRouterBoundary,
    readonly contextFor: (signal: AbortSignal) => unknown,
    readonly adapterId?: string,
  ) {}

  async transcribe(chunks: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    const sequenced = sequenceChunks(chunks);
    for await (const item of this.router.streamStt(
      sequenced,
      this.contextFor(signal),
      this.adapterId,
    )) {
      if (item.kind !== "complete") continue;
      if (item.result.ok) return item.result.output;
      throw new AudioSttPortError(item.result.error.code);
    }
    throw new AudioSttPortError("provider_error");
  }
}

export type AudioStreamTerminal =
  | Readonly<{
      outcome: "COMPLETED";
      transcript: Readonly<{ text: string; language: string; durationMs: number }>;
    }>
  | Readonly<{
      outcome:
        | "ACTOR_LOGOUT"
        | "GRANT_EXPIRED"
        | "GRANT_REVOKED"
        | "PROVIDER_FAILURE"
        | "SESSION_ENDED"
        | "STREAM_CANCELLED";
    }>;

export type FrameAcceptance =
  | Readonly<{ outcome: "ACCEPTED" }>
  | Readonly<{
      outcome: "REJECTED";
      reason:
        | "BUFFER_LIMIT_EXCEEDED"
        | "CONSENT_REQUIRED"
        | "GRANT_EXPIRED"
        | "GRANT_REVOKED"
        | "INVALID_SEQUENCE"
        | "STREAM_NOT_ACTIVE";
    }>;

type ForcedTerminal = Exclude<AudioStreamTerminal["outcome"], "COMPLETED" | "PROVIDER_FAILURE">;

type GrantRecord = {
  readonly grant: CaptureGrant;
  state: "ACTIVE" | "EXPIRED" | "REVOKED";
  stream: StreamRecord | undefined;
};

type StreamRecord = {
  readonly queue: AudioChunkQueue;
  readonly cancellation: AbortController;
  nextSequence: number;
  forcedTerminal: ForcedTerminal | undefined;
};

export interface AudioCaptureCoordinatorOptions {
  readonly grantTtlMs?: number;
  readonly createGrantId: () => string;
}

const MAX_BUFFERED_DURATION_MS = 30_000;

export class AudioCaptureCoordinator {
  readonly #router: ServerAudioSttPort;
  readonly #grantTtlMs: number;
  readonly #createGrantId: () => string;
  readonly #grants = new Map<string, GrantRecord>();

  constructor(router: ServerAudioSttPort, options: AudioCaptureCoordinatorOptions) {
    this.#router = router;
    this.#grantTtlMs = options.grantTtlMs ?? 60_000;
    this.#createGrantId = options.createGrantId;
    if (this.#grantTtlMs <= 0) throw new TypeError("grant TTL must be positive");
  }

  issueGrant(untrustedConsent: unknown, nowMs: number): CaptureGrant {
    const consent = AudioCaptureConsentSchema.parse(structuredClone(untrustedConsent));
    if (consent.acceptedAtMs > nowMs) throw new TypeError("consent timestamp is in the future");
    const grant = CaptureGrantSchema.parse({
      captureGrantId: this.#createGrantId(),
      presentationSessionId: consent.presentationSessionId,
      presentationSessionEpoch: consent.presentationSessionEpoch,
      actorId: consent.actorId,
      captureDeviceId: consent.captureDeviceId,
      consentRecordId: consent.consentRecordId,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + this.#grantTtlMs,
    });
    Object.freeze(grant);
    this.#grants.set(grant.captureGrantId, { grant, state: "ACTIVE", stream: undefined });
    return grant;
  }

  startCapture(grantId: string, actorId: string, nowMs: number): Promise<AudioStreamTerminal> {
    const record = this.#grants.get(grantId);
    if (record === undefined || record.grant.actorId !== actorId) {
      return Promise.resolve({ outcome: "GRANT_REVOKED" });
    }
    if (record.state !== "ACTIVE") return Promise.resolve({ outcome: stateTerminal(record.state) });
    if (nowMs >= record.grant.expiresAtMs) {
      record.state = "EXPIRED";
      return Promise.resolve({ outcome: "GRANT_EXPIRED" });
    }
    if (record.stream !== undefined) return Promise.resolve({ outcome: "STREAM_CANCELLED" });

    const stream: StreamRecord = {
      queue: new AudioChunkQueue(),
      cancellation: new AbortController(),
      nextSequence: 0,
      forcedTerminal: undefined,
    };
    record.stream = stream;
    return this.#run(record, stream);
  }

  pushFrame(
    grantId: string,
    sequence: number,
    samples: Uint8Array,
    durationMs: number,
    nowMs: number,
  ): FrameAcceptance {
    const record = this.#grants.get(grantId);
    if (record === undefined) return { outcome: "REJECTED", reason: "CONSENT_REQUIRED" };
    if (record.state === "REVOKED") return { outcome: "REJECTED", reason: "GRANT_REVOKED" };
    if (record.state === "EXPIRED" || nowMs >= record.grant.expiresAtMs) {
      this.#terminate(record, "GRANT_EXPIRED", "EXPIRED");
      return { outcome: "REJECTED", reason: "GRANT_EXPIRED" };
    }
    const stream = record.stream;
    if (stream === undefined) return { outcome: "REJECTED", reason: "STREAM_NOT_ACTIVE" };
    if (!Number.isSafeInteger(sequence) || sequence !== stream.nextSequence) {
      return { outcome: "REJECTED", reason: "INVALID_SEQUENCE" };
    }
    if (
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      durationMs > MAX_BUFFERED_DURATION_MS ||
      stream.queue.bufferedDurationMs + durationMs > MAX_BUFFERED_DURATION_MS
    ) {
      return { outcome: "REJECTED", reason: "BUFFER_LIMIT_EXCEEDED" };
    }
    stream.nextSequence += 1;
    stream.queue.push(samples.slice(), durationMs);
    return { outcome: "ACCEPTED" };
  }

  stopCapture(grantId: string, _nowMs: number): Readonly<{ outcome: "STOPPED" | "NOT_ACTIVE" }> {
    const stream = this.#grants.get(grantId)?.stream;
    if (stream === undefined) return { outcome: "NOT_ACTIVE" };
    stream.queue.close();
    return { outcome: "STOPPED" };
  }

  revokeGrant(grantId: string, _nowMs: number): Readonly<{ outcome: "REVOKED" | "NOT_FOUND" }> {
    const record = this.#grants.get(grantId);
    if (record === undefined) return { outcome: "NOT_FOUND" };
    this.#terminate(record, "GRANT_REVOKED", "REVOKED");
    return { outcome: "REVOKED" };
  }

  expireGrants(nowMs: number): void {
    for (const record of this.#grants.values()) {
      if (record.state === "ACTIVE" && nowMs >= record.grant.expiresAtMs) {
        this.#terminate(record, "GRANT_EXPIRED", "EXPIRED");
      }
    }
  }

  actorLoggedOut(actorId: string, _nowMs: number): void {
    for (const record of this.#grants.values()) {
      if (record.grant.actorId === actorId && record.state === "ACTIVE") {
        this.#terminate(record, "ACTOR_LOGOUT", "REVOKED");
      }
    }
  }

  sessionEnded(presentationSessionId: string, _nowMs: number): void {
    for (const record of this.#grants.values()) {
      if (
        record.grant.presentationSessionId === presentationSessionId &&
        record.state === "ACTIVE"
      ) {
        this.#terminate(record, "SESSION_ENDED", "REVOKED");
      }
    }
  }

  cancelStream(grantId: string, _nowMs: number): void {
    const record = this.#grants.get(grantId);
    if (record !== undefined) this.#terminate(record, "STREAM_CANCELLED", record.state);
  }

  bufferedBytes(grantId: string): number {
    return this.#grants.get(grantId)?.stream?.queue.bufferedBytes ?? 0;
  }

  async #run(record: GrantRecord, stream: StreamRecord): Promise<AudioStreamTerminal> {
    try {
      const transcript = await this.#router.transcribe(stream.queue, stream.cancellation.signal);
      return stream.forcedTerminal === undefined
        ? { outcome: "COMPLETED", transcript: Object.freeze(structuredClone(transcript)) }
        : { outcome: stream.forcedTerminal };
    } catch {
      return { outcome: stream.forcedTerminal ?? "PROVIDER_FAILURE" };
    } finally {
      stream.queue.clear();
      record.stream = undefined;
    }
  }

  #terminate(
    record: GrantRecord,
    terminal: ForcedTerminal,
    state: GrantRecord["state"],
  ): void {
    record.state = state;
    const stream = record.stream;
    if (stream === undefined) return;
    stream.forcedTerminal = terminal;
    stream.queue.clear();
    stream.cancellation.abort(new Error(terminal));
  }
}

class AudioChunkQueue implements AsyncIterable<Uint8Array> {
  readonly #queued: { samples: Uint8Array; durationMs: number }[] = [];
  #waiter: ((result: IteratorResult<Uint8Array>) => void) | undefined;
  #closed = false;
  bufferedBytes = 0;
  bufferedDurationMs = 0;

  push(samples: Uint8Array, durationMs: number): void {
    if (this.#closed) return;
    const waiter = this.#waiter;
    if (waiter !== undefined) {
      this.#waiter = undefined;
      waiter({ done: false, value: samples });
      return;
    }
    this.#queued.push({ samples, durationMs });
    this.bufferedBytes += samples.byteLength;
    this.bufferedDurationMs += durationMs;
  }

  close(): void {
    this.#closed = true;
    this.#flushWaiter();
  }

  clear(): void {
    this.#queued.length = 0;
    this.bufferedBytes = 0;
    this.bufferedDurationMs = 0;
    this.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        const queued = this.#queued.shift();
        if (queued !== undefined) {
          this.bufferedBytes -= queued.samples.byteLength;
          this.bufferedDurationMs -= queued.durationMs;
          return { done: false, value: queued.samples };
        }
        if (this.#closed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<Uint8Array>>((resolve) => {
          this.#waiter = resolve;
        });
      },
      return: async () => {
        this.clear();
        return { done: true, value: undefined };
      },
    };
  }

  #flushWaiter(): void {
    const waiter = this.#waiter;
    if (waiter !== undefined) {
      this.#waiter = undefined;
      waiter({ done: true, value: undefined });
    }
  }
}

async function* sequenceChunks(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<Readonly<{ sequence: number; audio: Uint8Array }>> {
  let sequence = 0;
  for await (const audio of chunks) {
    yield { sequence, audio };
    sequence += 1;
  }
}

function stateTerminal(state: "ACTIVE" | "EXPIRED" | "REVOKED"): ForcedTerminal {
  return state === "EXPIRED" ? "GRANT_EXPIRED" : "GRANT_REVOKED";
}

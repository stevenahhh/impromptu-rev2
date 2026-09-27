import {
  createSttStreamEventValidator,
  STT_AUDIO_MIME_TYPE,
  type SttStreamEvent,
  SttStreamEventSchema,
} from "@impromptu/contracts/private";
import type { RecommendationOutcome } from "@impromptu/contracts/retrieval";
import {
  AudioCaptureCoordinator,
  type AudioStreamTerminal,
  RouterBackedAudioSttPort,
  type StreamingSttRouterBoundary,
} from "./audio-capture.ts";
import { abstain } from "./verifier/recommendation-outcome.ts";

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
  | Readonly<{ kind: "TRANSCRIPT"; event: SttStreamEvent }>
  | Readonly<{
      kind: "RECOMMENDATION";
      presentationSessionId: string;
      sessionGeneration: number;
      finalSegmentId: string;
      recommendation: RecommendationOutcome;
    }>
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

export type AudioRecommendationContext = Readonly<{
  deckVersion: string;
  manifestHash: string;
}>;

export interface AudioIngestServiceOptions {
  readonly router: StreamingSttRouterBoundary;
  readonly contextFor: (identity: AudioCaptureIdentity, signal: AbortSignal) => unknown;
  readonly recommendations?: Readonly<{
    resolveContext(
      identity: AudioCaptureIdentity,
    ): AudioRecommendationContext | null | Promise<AudioRecommendationContext | null>;
    recommend(accountSessionId: string, input: unknown): Promise<RecommendationOutcome>;
  }>;
  readonly coachingPreviewEnabledFor?: (identity: AudioCaptureIdentity) => boolean;
  readonly onFinal?: (
    identity: AudioCaptureIdentity,
    event: Extract<SttStreamEvent, { kind: "FINAL" }>,
  ) => void;
  readonly adapterId?: string;
  readonly grantTtlMs?: number;
  readonly createGrantId: () => string;
}

type GrantState = "ACTIVE" | "STARTED" | "STOPPING" | "CONSUMED" | "EXPIRED" | "REVOKED";

type GrantBinding = {
  readonly accountSessionId: string;
  readonly identity: AudioCaptureIdentity;
  readonly expiresAtMs: number;
  readonly validateTranscriptEvent: ReturnType<typeof createSttStreamEventValidator>;
  state: GrantState;
  eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  eventsOpened: boolean;
};

type PendingTranscription = Readonly<{ grantId: string; identity: AudioCaptureIdentity }>;

/**
 * Per-presentation bound on recommendation work in flight behind the transcript path. At four
 * entries the lane holds roughly twenty seconds of provider headroom (one running call plus
 * three queued under the 5,400ms per-run deadline); a deeper backlog reports an overload
 * abstention immediately instead of queueing without bound.
 */
const MAX_RECOMMENDATION_LANE_DEPTH = 4;

type RecommendationJob = {
  readonly grantId: string;
  cancelled: boolean;
  run: () => Promise<void>;
};

type RecommendationLane = {
  readonly queue: RecommendationJob[];
  running: RecommendationJob | undefined;
  tail: Promise<void>;
};

const encoder = new TextEncoder();

class EventForwardingAudioSttPort {
  #pending: PendingTranscription | undefined;

  constructor(
    private readonly router: StreamingSttRouterBoundary,
    private readonly contextFor: AudioIngestServiceOptions["contextFor"],
    private readonly publishTranscript: (grantId: string, event: SttStreamEvent) => void,
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
      if (item.kind !== "transcript") {
        yield item;
        continue;
      }
      this.publishTranscript(grantId, SttStreamEventSchema.parse(item.event));
      yield item;
    }
  }
}

class DefaultAudioIngestService implements AudioIngestService {
  readonly #coordinator: AudioCaptureCoordinator;
  readonly #port: EventForwardingAudioSttPort;
  readonly #bindings = new Map<string, GrantBinding>();
  readonly #recommendationKeys = new Set<string>();
  readonly #recommendationLanes = new Map<string, RecommendationLane>();
  readonly #recommendations: AudioIngestServiceOptions["recommendations"];
  readonly #coachingPreviewEnabledFor: NonNullable<
    AudioIngestServiceOptions["coachingPreviewEnabledFor"]
  >;
  readonly #onFinal: AudioIngestServiceOptions["onFinal"];

  constructor(options: AudioIngestServiceOptions) {
    this.#recommendations = options.recommendations;
    this.#coachingPreviewEnabledFor = options.coachingPreviewEnabledFor ?? (() => false);
    this.#onFinal = options.onFinal;
    this.#port = new EventForwardingAudioSttPort(
      options.router,
      options.contextFor,
      (grantId, event) => this.#acceptTranscript(grantId, event),
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
      validateTranscriptEvent: createSttStreamEventValidator(),
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
        this.#cancelRecommendations(grantId);
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
    void terminal.then(async (result) => {
      // A natural end (the provider finished or failed while the grant was still live) drains
      // the recommendation lane first so every accepted FINAL still publishes its ordered
      // outcome before the terminal. Abort paths - stop, revoke, session end, disconnect -
      // already changed the binding state and cancelled the lane, so their terminals publish
      // without waiting on provider work.
      if (binding.state === "STARTED") {
        await this.#drainRecommendations(binding.identity.presentationSessionId);
      }
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
    if (binding !== undefined) {
      binding.state = "STOPPING";
      this.#cancelRecommendations(grantId);
    }
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

  #acceptTranscript(grantId: string, input: SttStreamEvent): void {
    const binding = this.#bindings.get(grantId);
    if (binding === undefined || (binding.state !== "STARTED" && binding.state !== "STOPPING")) {
      return;
    }

    let event: SttStreamEvent;
    try {
      event = binding.validateTranscriptEvent(input);
    } catch {
      return;
    }
    if (event.kind === "ABORT") return;
    if (event.kind === "PARTIAL" || event.kind === "REPLACE") {
      if (this.#coachingPreviewEnabledFor(binding.identity)) {
        this.#publish(grantId, { kind: "TRANSCRIPT", event });
      }
      return;
    }

    this.#onFinal?.(binding.identity, event);
    // The FINAL transcript forwards synchronously: recommendation work must never hold the
    // router iteration, or a slow provider would delay every transcript that follows it.
    this.#publish(grantId, { kind: "TRANSCRIPT", event });
    const recommendations = this.#recommendations;
    if (recommendations === undefined || binding.state !== "STARTED") return;
    const key = `${binding.identity.presentationSessionId}\u0000${event.sessionGeneration}\u0000${event.finalSegmentId}`;
    if (this.#recommendationKeys.has(key)) return;
    this.#recommendationKeys.add(key);
    this.#dispatchRecommendation(grantId, binding.identity, binding.accountSessionId, event);
  }

  /**
   * Queues one FINAL's recommendation on the presentation's serial lane. Dispatch order
   * decides report order: jobs run one at a time and publish their outcomes in the order the
   * FINALs arrived, so a slow provider can never reorder or starve a later segment's entry.
   */
  #dispatchRecommendation(
    grantId: string,
    identity: AudioCaptureIdentity,
    accountSessionId: string,
    event: Extract<SttStreamEvent, { kind: "FINAL" }>,
  ): void {
    const recommendations = this.#recommendations;
    if (recommendations === undefined) return;
    const presentationSessionId = identity.presentationSessionId;
    const lane = this.#recommendationLanes.get(presentationSessionId) ?? {
      queue: [],
      running: undefined,
      tail: Promise.resolve(),
    };
    this.#recommendationLanes.set(presentationSessionId, lane);

    if (lane.queue.length + (lane.running === undefined ? 0 : 1) >= MAX_RECOMMENDATION_LANE_DEPTH) {
      this.#publish(grantId, {
        kind: "RECOMMENDATION",
        presentationSessionId,
        sessionGeneration: event.sessionGeneration,
        finalSegmentId: event.finalSegmentId,
        recommendation: abstain("BUDGET_EXCEEDED", Date.now(), Date.now()),
      });
      return;
    }

    const job: RecommendationJob = {
      grantId,
      cancelled: false,
      run: async () => {
        if (job.cancelled) return;
        // Context resolves at run time so a queued job reads the presentation's current deck,
        // never a stale snapshot taken at dispatch.
        const context = await Promise.resolve(recommendations.resolveContext(identity)).catch(
          () => null,
        );
        if (context === null || job.cancelled) return;
        const state = this.#bindings.get(grantId)?.state;
        if (state !== "STARTED") return;
        const startedAtMs = Date.now();
        // A provider rejection degrades to a typed abstention on the private stream instead of
        // faulting the capture itself.
        const recommendation = await recommendations
          .recommend(accountSessionId, {
            query: event.transcript.text,
            deckVersion: context.deckVersion,
            manifestHash: context.manifestHash,
            maxResults: 3,
          })
          .catch(() => abstain("MODEL_FAILURE", startedAtMs, Date.now()));
        // A grant that stopped, ended, or closed meanwhile must not attach a late outcome.
        if (job.cancelled) return;
        this.#publish(grantId, {
          kind: "RECOMMENDATION",
          presentationSessionId,
          sessionGeneration: event.sessionGeneration,
          finalSegmentId: event.finalSegmentId,
          recommendation,
        });
      },
    };

    lane.queue.push(job);
    const pump = async (): Promise<void> => {
      const next = lane.queue.shift();
      if (next === undefined) {
        if (
          lane.running === undefined &&
          this.#recommendationLanes.get(presentationSessionId) === lane
        ) {
          this.#recommendationLanes.delete(presentationSessionId);
        }
        return;
      }
      lane.running = next;
      try {
        // run() already converts provider failures to abstentions; this guard keeps the serial
        // lane alive if publishing throws while the stream is being torn down.
        await next.run().catch(() => undefined);
      } finally {
        lane.running = undefined;
        await pump();
      }
    };
    lane.tail = lane.tail.then(pump);
  }

  #cancelRecommendations(grantId: string): void {
    const binding = this.#bindings.get(grantId);
    if (binding === undefined) return;
    const lane = this.#recommendationLanes.get(binding.identity.presentationSessionId);
    if (lane === undefined) return;
    for (const job of lane.queue) {
      if (job.grantId === grantId) job.cancelled = true;
    }
    if (lane.running?.grantId === grantId) lane.running.cancelled = true;
  }

  /**
   * Waits until every job dispatched so far has run. `lane.tail` grows as jobs settle, so this
   * must re-read the chain until the lane is empty rather than snapshot it once.
   */
  async #drainRecommendations(presentationSessionId: string): Promise<void> {
    let lane = this.#recommendationLanes.get(presentationSessionId);
    while (lane !== undefined) {
      await lane.tail;
      lane =
        lane.queue.length > 0 || lane.running !== undefined
          ? lane
          : this.#recommendationLanes.get(presentationSessionId);
    }
  }

  #publish(grantId: string, event: AudioIngestEvent): void {
    const binding = this.#bindings.get(grantId);
    const controller = binding?.eventController;
    if (binding === undefined || controller === undefined) return;
    controller.enqueue(encodeEvent(event));
    if (event.kind === "TERMINAL") {
      binding.eventController = undefined;
      controller.close();
      this.#cancelRecommendations(grantId);
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

import {
  createProjectionRealtimeProtocol,
  PreparedEvidenceProjectionGateway,
  type ProjectionRealtimeConnection,
  type ProjectionRealtimeMessage,
} from "@impromptu/projection-gateway";
import { applyRealtimeTransition, createRealtimeStageState } from "@impromptu/state";

export interface RealtimeSoakEvidence {
  readonly profile: "venue-like-exact-event";
  readonly commandCount: number;
  readonly reconnectCount: number;
  readonly commandToStageAppliedP95Ms: number;
  readonly reconnectToSnapshotP95Ms: number;
  readonly duplicateVisibleEffects: number;
  readonly staleEpochAcceptances: number;
  readonly staleCardResurrections: number;
  readonly liveLeaseMs: number;
  readonly silentPartitionExposureMs: number;
}

function percentile95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * 0.95) - 1);
  const value = ordered[index];
  if (value === undefined) throw new Error("latency sample set is empty");
  return Math.round(value * 1_000) / 1_000;
}

function exactSignal<Value>(label: string, timeoutMs: number) {
  let resolve: ((value: Value) => void) | null = null;
  let reject: ((error: Error) => void) | null = null;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  const signal = AbortSignal.timeout(timeoutMs);
  signal.addEventListener(
    "abort",
    () => reject?.(new Error(`${label} timed out after ${timeoutMs}ms`)),
    { once: true },
  );
  return {
    promise,
    resolve(value: Value) {
      if (resolve === null) throw new Error(`${label} resolved more than once`);
      const current = resolve;
      resolve = null;
      reject = null;
      current(value);
    },
  };
}

const deck = {
  deckVersion: "deck_soak",
  manifestHash: "a".repeat(64),
  title: "WP5 venue soak",
  slides: [
    {
      publicSlideKey: "slide_one",
      ordinal: 1,
      image: {
        url: "https://public.example.test/one.png",
        contentHash: "b".repeat(64),
        width: 1920,
        height: 1080,
      },
      accessibilityLabel: "Slide one",
    },
    {
      publicSlideKey: "slide_two",
      ordinal: 2,
      image: {
        url: "https://public.example.test/two.png",
        contentHash: "c".repeat(64),
        width: 1920,
        height: 1080,
      },
      accessibilityLabel: "Slide two",
    },
  ],
};

export async function runRealtimeSoak(): Promise<RealtimeSoakEvidence> {
  const gateway = new PreparedEvidenceProjectionGateway();
  let nowMs = 1_000;
  const join = gateway.createDisplayJoin(
    {
      displayId: "display_soak",
      displayFingerprint: "venue-stage-fingerprint",
      deckVersion: deck.deckVersion,
    },
    nowMs,
  );
  const bound = gateway.bindDisplay(
    {
      displayJoinId: join.displayJoinId,
      presentationSessionId: "ps_soak",
      presentationSessionEpoch: "pse_1",
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: deck.deckVersion,
      approvedDisplayId: join.displayId,
      approvedDisplayFingerprint: join.displayFingerprint,
      deck,
    },
    nowMs + 1,
  );
  if (bound.outcome !== "BOUND") throw new Error("soak display binding failed");

  const receipts = new Map<
    string,
    {
      status: "STAGE_APPLIED";
      commandId: string;
      presentationSessionEpoch: string;
      displayBindingEpoch: string;
      publicPlaybackRevision: string;
      appliedAtMs: number;
    }
  >();
  const protocol = createProjectionRealtimeProtocol({
    gateway,
    allowedOrigin: "https://stage.example.test",
    now: () => nowMs,
    async recordApplied(input) {
      const existing = receipts.get(input.commandId);
      if (existing !== undefined) return existing;
      const commandIndex = Number(input.commandId.slice("cmd_soak_".length));
      const publicPlaybackRevision = `pbr_${commandIndex}`;
      if (
        !Number.isSafeInteger(commandIndex) ||
        !gateway.recordPlaybackApplied("ps_soak", input.displayBindingEpoch, publicPlaybackRevision)
      ) {
        return null;
      }
      const receipt = {
        status: "STAGE_APPLIED" as const,
        commandId: input.commandId,
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: input.displayBindingEpoch,
        publicPlaybackRevision,
        appliedAtMs: nowMs,
      };
      receipts.set(input.commandId, receipt);
      return receipt;
    },
  });

  let state = createRealtimeStageState(
    {
      presentationSessionId: "ps_soak",
      presentationSessionEpoch: "pse_1",
      displayBindingEpoch: "dbe_1",
      deckVersion: deck.deckVersion,
      manifestHash: deck.manifestHash,
    },
    { publicSlideKey: "slide_one", occurrenceSeq: 1 },
  );
  let connection: ProjectionRealtimeConnection | null = null;
  let duplicateVisibleEffects = 0;
  let staleEpochAcceptances = 0;
  let staleCardResurrections = 0;
  const receiptWaiters = new Map<string, ReturnType<typeof exactSignal<unknown>>>();

  const onMessage = (message: ProjectionRealtimeMessage) => {
    if (message.kind === "COMMAND") {
      const commandIndex = Number(message.payload.commandId.slice("cmd_soak_".length));
      const result = applyRealtimeTransition(state, {
        type: "ABSOLUTE_PLAYBACK",
        commandId: message.payload.commandId,
        presentationSessionEpoch: message.payload.presentationSessionEpoch,
        displayBindingEpoch: message.payload.displayBindingEpoch,
        publicPlaybackRevision: `pbr_${commandIndex}`,
        occurrence: message.payload.occurrence,
        blackout: message.payload.blackout,
      });
      state = result.state;
      if (result.outcome === "DUPLICATE") duplicateVisibleEffects += result.effects.length;
      if (result.outcome === "STALE_EPOCH") staleEpochAcceptances += 1;
      void connection?.receive(
        JSON.stringify({
          kind: "STAGE_APPLIED",
          payload: {
            commandId: message.payload.commandId,
            displayBindingEpoch: message.payload.displayBindingEpoch,
          },
        }),
      );
    }
    if (message.kind === "RECEIPT") {
      receiptWaiters.get(message.payload.commandId)?.resolve(message.payload);
      receiptWaiters.delete(message.payload.commandId);
    }
  };
  connection = protocol.connect(bound.session.audienceDisplaySessionId, onMessage);
  if (connection === null) throw new Error("soak realtime connection failed");

  const commandLatencies: number[] = [];
  for (let index = 1; index <= 500; index += 1) {
    const commandId = `cmd_soak_${index}`;
    const receipt = exactSignal<unknown>(commandId, 300);
    receiptWaiters.set(commandId, receipt);
    const startedAt = performance.now();
    const event = {
      commandId,
      displayBindingEpoch: "dbe_1",
      acceptedControlRevision: `cr_${index}`,
      occurrence: {
        publicSlideKey: index % 2 === 0 ? "slide_two" : "slide_one",
        occurrenceSeq: index + 1,
      },
      blackout: index % 37 === 0,
    };
    if (!gateway.projectPlayback("ps_soak", event)) throw new Error(`${commandId} was rejected`);
    await receipt.promise;
    commandLatencies.push(performance.now() - startedAt);
    if (index % 10 === 0) gateway.projectPlayback("ps_soak", event);
    if (
      gateway.projectPlayback("ps_soak", {
        ...event,
        commandId: `cmd_stale_${index}`,
        displayBindingEpoch: "dbe_0",
      })
    ) {
      staleEpochAcceptances += 1;
    }
  }

  const reconnectLatencies: number[] = [];
  for (let index = 0; index < 50; index += 1) {
    connection.close();
    state = applyRealtimeTransition(state, { type: "PARTITION", reason: "NETWORK_ERROR" }).state;
    state = applyRealtimeTransition(state, { type: "RECONNECT" }).state;
    const snapshotSignal = exactSignal<ReturnType<typeof gateway.reconcileSnapshot>>(
      `snapshot-${index}`,
      2_000,
    );
    const startedAt = performance.now();
    connection = protocol.connect(bound.session.audienceDisplaySessionId, onMessage);
    if (connection === null) throw new Error(`reconnect ${index} failed`);
    queueMicrotask(() =>
      snapshotSignal.resolve(
        gateway.reconcileSnapshot(
          bound.session.audienceDisplaySessionId,
          {
            role: "PUBLIC_STAGE",
            presentationSessionEpoch: "pse_1",
            displayBindingEpoch: "dbe_1",
            deckVersion: deck.deckVersion,
            manifestHash: deck.manifestHash,
          },
          nowMs,
        ),
      ),
    );
    const result = await snapshotSignal.promise;
    if (result.outcome !== "SNAPSHOT") throw new Error(`reconnect ${index} requires reconcile`);
    const restored = applyRealtimeTransition(state, {
      type: "SNAPSHOT",
      verifiedStateHash: result.snapshot.stateHash,
      snapshot: {
        role: result.snapshot.role,
        stateHash: result.snapshot.stateHash,
        presentationSessionId: result.snapshot.presentationSessionId,
        presentationSessionEpoch: result.snapshot.presentationSessionEpoch,
        displayBindingEpoch: result.snapshot.displayBindingEpoch,
        deckVersion: result.snapshot.deck.deckVersion,
        manifestHash: result.snapshot.deck.manifestHash,
        publicPlaybackRevision: result.snapshot.publicPlaybackRevision,
        publicCardRevision: result.snapshot.publicCardRevision,
        occurrence: result.snapshot.occurrence,
        blackout: result.snapshot.blackout,
        cards: [],
      },
    });
    if (restored.outcome !== "APPLIED") throw new Error(`snapshot ${index} was not applied`);
    state = restored.state;
    reconnectLatencies.push(performance.now() - startedAt);
  }

  nowMs = 2_000;
  const liveLeaseMs = 3_000;
  if (
    !gateway.projectCard("ps_soak", {
      projectionId: "projection_live_soak",
      status: "PUBLISHED",
      mode: "LIVE",
      leaseExpiresAtMs: nowMs + liveLeaseMs,
      claim: "Live leased claim",
      supportSummary: "Lease bounded",
      sourceLabel: "Verified source",
      publishedAtMs: nowMs,
      expiresAtMs: nowMs + liveLeaseMs,
      publicCardRevision: "pcr_1",
      deckVersion: deck.deckVersion,
      manifestHash: deck.manifestHash,
      occurrence: state.occurrence,
    })
  ) {
    throw new Error("valid live card lease was rejected");
  }
  state = applyRealtimeTransition(state, {
    type: "CARD_UPSERT",
    nowMs,
    card: {
      projectionId: "projection_live_soak",
      mode: "LIVE",
      leaseExpiresAtMs: nowMs + liveLeaseMs,
      publicCardRevision: "pcr_1",
    },
  }).state;
  nowMs += liveLeaseMs;
  state = applyRealtimeTransition(state, { type: "CLOCK", nowMs }).state;
  if (state.visibleCardIds.includes("projection_live_soak")) staleCardResurrections += 1;
  const expiredSnapshot = gateway.snapshot(bound.session.audienceDisplaySessionId, nowMs);
  if (expiredSnapshot?.cards.some((card) => card.projectionId === "projection_live_soak")) {
    staleCardResurrections += 1;
  }
  connection.close();

  return {
    profile: "venue-like-exact-event",
    commandCount: 500,
    reconnectCount: 50,
    commandToStageAppliedP95Ms: percentile95(commandLatencies),
    reconnectToSnapshotP95Ms: percentile95(reconnectLatencies),
    duplicateVisibleEffects,
    staleEpochAcceptances,
    staleCardResurrections,
    liveLeaseMs,
    silentPartitionExposureMs: liveLeaseMs,
  };
}

export interface DisplayIdentity {
  readonly displayId: string;
  readonly displayFingerprint: string;
}

export interface DisplayJoinView extends DisplayIdentity {
  readonly displayJoinId: string;
  readonly deckVersion: string;
  readonly expiresAtMs: number;
}

export interface StageCardView {
  readonly projectionId: string;
  readonly status: "PUBLISHED";
  readonly claim: string;
  readonly supportSummary: string;
  readonly sourceLabel: string;
  readonly publicCardRevision: string;
}

export interface StagePlaybackEvent {
  readonly commandId: string;
  readonly displayBindingEpoch: string;
  readonly acceptedControlRevision: string;
  readonly occurrence: { readonly publicSlideKey: string; readonly occurrenceSeq: number };
  readonly blackout: boolean;
}

export interface StageCardTombstone {
  readonly projectionId: string;
  readonly status: "RETRACTED" | "EXPIRED";
  readonly publicCardRevision: string;
  readonly occurredAtMs: number;
}

export type StageCardEvent = StageCardView | StageCardTombstone;

export interface StageSnapshotView {
  readonly occurrence: { readonly publicSlideKey: string; readonly occurrenceSeq: number };
  readonly publicSlideKeys?: readonly string[];
  readonly cards: readonly StageCardView[];
  readonly publicCardRevision: string;
  readonly tombstoneWatermark: string;
  readonly tombstoneRetentionMs: number;
}

export interface StageSubscription {
  close(): void;
}

export interface StageEventObserver {
  onPlayback(event: StagePlaybackEvent): void;
  onCard(event: StageCardEvent): void;
  onClose(reason: string): void;
  onOpen?(): void;
}

interface BrowserEventSource {
  close(): void;
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export type EventSourceFactory = (url: string) => BrowserEventSource;

export interface StageSessionClient {
  createJoin(identity: DisplayIdentity, deckVersion: string): Promise<DisplayJoinView>;
  claim(join: DisplayJoinView): Promise<void>;
  snapshot(): Promise<StageSnapshotView>;
  subscribe(observer: StageEventObserver, timeoutMs?: number): Promise<StageSubscription>;
  recordApplied(event: StagePlaybackEvent): Promise<unknown>;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function displayJoin(value: unknown): DisplayJoinView | null {
  const candidate = record(value);
  if (
    candidate === null ||
    typeof candidate.displayJoinId !== "string" ||
    typeof candidate.displayId !== "string" ||
    typeof candidate.displayFingerprint !== "string" ||
    typeof candidate.deckVersion !== "string" ||
    typeof candidate.expiresAtMs !== "number"
  ) {
    return null;
  }
  return {
    displayJoinId: candidate.displayJoinId,
    displayId: candidate.displayId,
    displayFingerprint: candidate.displayFingerprint,
    deckVersion: candidate.deckVersion,
    expiresAtMs: candidate.expiresAtMs,
  };
}

function snapshot(value: unknown): StageSnapshotView | null {
  const candidate = record(value);
  const occurrence = record(candidate?.occurrence);
  if (
    candidate === null ||
    occurrence === null ||
    typeof occurrence.publicSlideKey !== "string" ||
    typeof occurrence.occurrenceSeq !== "number" ||
    !Array.isArray(candidate.cards) ||
    typeof candidate.publicCardRevision !== "string" ||
    typeof candidate.tombstoneWatermark !== "string" ||
    typeof candidate.tombstoneRetentionMs !== "number"
  ) {
    return null;
  }
  const deck = record(candidate.deck);
  const deckSlides = Array.isArray(deck?.slides) ? deck.slides : [];
  const publicSlideKeys: string[] = [];
  for (const valueSlide of deckSlides) {
    const slide = record(valueSlide);
    if (slide === null || typeof slide.publicSlideKey !== "string") return null;
    publicSlideKeys.push(slide.publicSlideKey);
  }
  const cards: StageCardView[] = [];
  for (const valueCard of candidate.cards) {
    const card = record(valueCard);
    if (
      card === null ||
      typeof card.projectionId !== "string" ||
      card.status !== "PUBLISHED" ||
      typeof card.claim !== "string" ||
      typeof card.supportSummary !== "string" ||
      typeof card.sourceLabel !== "string" ||
      typeof card.publicCardRevision !== "string"
    ) {
      return null;
    }
    cards.push({
      projectionId: card.projectionId,
      status: card.status,
      claim: card.claim,
      supportSummary: card.supportSummary,
      sourceLabel: card.sourceLabel,
      publicCardRevision: card.publicCardRevision,
    });
  }
  return {
    occurrence: {
      publicSlideKey: occurrence.publicSlideKey,
      occurrenceSeq: occurrence.occurrenceSeq,
    },
    publicSlideKeys: publicSlideKeys.length === 0 ? [occurrence.publicSlideKey] : publicSlideKeys,
    cards,
    publicCardRevision: candidate.publicCardRevision,
    tombstoneWatermark: candidate.tombstoneWatermark,
    tombstoneRetentionMs: candidate.tombstoneRetentionMs,
  };
}

function playback(value: unknown): StagePlaybackEvent | null {
  const candidate = record(value);
  const occurrence = record(candidate?.occurrence);
  return candidate !== null &&
    occurrence !== null &&
    typeof candidate.commandId === "string" &&
    typeof candidate.displayBindingEpoch === "string" &&
    typeof candidate.acceptedControlRevision === "string" &&
    typeof occurrence.publicSlideKey === "string" &&
    typeof occurrence.occurrenceSeq === "number" &&
    typeof candidate.blackout === "boolean"
    ? {
        commandId: candidate.commandId,
        displayBindingEpoch: candidate.displayBindingEpoch,
        acceptedControlRevision: candidate.acceptedControlRevision,
        occurrence: {
          publicSlideKey: occurrence.publicSlideKey,
          occurrenceSeq: occurrence.occurrenceSeq,
        },
        blackout: candidate.blackout,
      }
    : null;
}

function cardEvent(value: unknown): StageCardEvent | null {
  const candidate = record(value);
  if (
    candidate !== null &&
    (candidate.status === "RETRACTED" || candidate.status === "EXPIRED") &&
    typeof candidate.projectionId === "string" &&
    typeof candidate.publicCardRevision === "string" &&
    typeof candidate.occurredAtMs === "number"
  ) {
    return {
      projectionId: candidate.projectionId,
      status: candidate.status,
      publicCardRevision: candidate.publicCardRevision,
      occurredAtMs: candidate.occurredAtMs,
    };
  }
  if (
    candidate !== null &&
    candidate.status === "PUBLISHED" &&
    typeof candidate.projectionId === "string" &&
    typeof candidate.claim === "string" &&
    typeof candidate.supportSummary === "string" &&
    typeof candidate.sourceLabel === "string" &&
    typeof candidate.publicCardRevision === "string"
  ) {
    return {
      projectionId: candidate.projectionId,
      status: candidate.status,
      claim: candidate.claim,
      supportSummary: candidate.supportSummary,
      sourceLabel: candidate.sourceLabel,
      publicCardRevision: candidate.publicCardRevision,
    };
  }
  return null;
}

function parseStreamMessage(
  event: Event,
):
  | Readonly<{ kind: "PLAYBACK"; payload: StagePlaybackEvent }>
  | Readonly<{ kind: "CARD"; payload: StageCardEvent }>
  | Readonly<{ kind: "CLOSE"; reason: string }>
  | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(event.data);
  } catch {
    return null;
  }
  const envelope = record(decoded);
  if (envelope?.kind === "PLAYBACK") {
    const payload = playback(envelope.payload);
    return payload === null ? null : { kind: "PLAYBACK", payload };
  }
  if (envelope?.kind === "CARD") {
    const payload = cardEvent(envelope.payload);
    return payload === null ? null : { kind: "CARD", payload };
  }
  if (envelope?.kind === "CLOSE") {
    const payload = record(envelope.payload);
    return payload !== null && typeof payload.reason === "string"
      ? { kind: "CLOSE", reason: payload.reason }
      : null;
  }
  return null;
}

export function createStageSessionClient(
  baseUrl = "",
  eventSourceFactory: EventSourceFactory = (url) => new EventSource(url),
): StageSessionClient {
  const headers = { "content-type": "application/json" };
  return {
    async createJoin(identity, deckVersion) {
      const response = await fetch(`${baseUrl}/v1/display-joins`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ ...identity, deckVersion }),
      });
      const body = displayJoin(await json(response));
      if (!response.ok || body === null) throw new Error("Display join could not be created.");
      return body;
    },
    async claim(join) {
      const response = await fetch(`${baseUrl}/v1/display-session`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(join),
      });
      if (!response.ok) throw new Error("The controller has not approved this display yet.");
    },
    async snapshot() {
      const response = await fetch(`${baseUrl}/v1/snapshot`, { credentials: "include" });
      const body = snapshot(await json(response));
      if (!response.ok || body === null) throw new Error("Public snapshot is unavailable.");
      return body;
    },
    async subscribe(observer, timeoutMs = 5_000) {
      const eventsUrl = `${baseUrl}/v1/events`;
      let source = eventSourceFactory(eventsUrl);
      const timeout = AbortSignal.timeout(timeoutMs);
      let opened = false;
      let everOpened = false;
      let closed = false;
      let resolveInitialOpen: (() => void) | null = null;
      const detach = (candidate: BrowserEventSource) => {
        candidate.removeEventListener("message", onMessage);
        candidate.removeEventListener("error", onError);
        candidate.removeEventListener("open", onOpen);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        detach(source);
        source.close();
      };
      const attach = (candidate: BrowserEventSource) => {
        candidate.addEventListener("message", onMessage);
        candidate.addEventListener("error", onError);
        candidate.addEventListener("open", onOpen);
      };
      const onMessage = (event: Event) => {
        const message = parseStreamMessage(event);
        if (message?.kind === "PLAYBACK") observer.onPlayback(message.payload);
        if (message?.kind === "CARD") observer.onCard(message.payload);
        if (message?.kind === "CLOSE") {
          observer.onClose(message.reason);
          close();
        }
      };
      const onError = () => {
        if (!opened || closed) return;
        opened = false;
        observer.onClose("NETWORK_ERROR");
        const failed = source;
        detach(failed);
        failed.close();
        source = eventSourceFactory(eventsUrl);
        attach(source);
      };
      const onOpen = () => {
        opened = true;
        if (everOpened) observer.onOpen?.();
        everOpened = true;
        resolveInitialOpen?.();
        resolveInitialOpen = null;
      };
      attach(source);
      await new Promise<void>((resolve, reject) => {
        resolveInitialOpen = resolve;
        timeout.addEventListener(
          "abort",
          () => {
            if (!everOpened) {
              close();
              reject(new Error(`Stage event channel did not open within ${timeoutMs}ms`));
            }
          },
          { once: true },
        );
      });
      return { close };
    },
    async recordApplied(event) {
      const response = await fetch(`${baseUrl}/v1/stage-applied`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          commandId: event.commandId,
          displayBindingEpoch: event.displayBindingEpoch,
        }),
      });
      const body = await json(response);
      if (!response.ok) throw new Error("Stage applied receipt was rejected.");
      return body;
    },
  };
}

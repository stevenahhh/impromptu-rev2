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
  readonly mode: "CURATED" | "LIVE";
  readonly leaseExpiresAtMs: number | null;
  readonly offlinePackage?: Readonly<{
    readonly offlineDisplayAllowed: boolean;
    readonly localExpiresAtMs: number;
    readonly signature: string;
    readonly signatureVerified: boolean;
  }>;
  readonly claim: string;
  readonly supportSummary: string;
  readonly sourceLabel: string;
  readonly publicCardRevision: string;
}

export interface StagePlaybackEvent {
  readonly commandId: string;
  readonly presentationSessionEpoch: string;
  readonly displayBindingEpoch: string;
  readonly acceptedControlRevision: string;
  readonly publicPlaybackRevision: string;
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
  readonly role: "PUBLIC_STAGE";
  readonly stateHash: string;
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly displayBindingEpoch: string;
  readonly deckVersion: string;
  readonly manifestHash: string;
  readonly deckSlides: readonly Readonly<{
    publicSlideKey: string;
    ordinal: number;
    imageUrl: string;
    imageContentHash: string;
    accessibilityLabel: string;
  }>[];
  readonly publicPlaybackRevision: string;
  readonly blackout: boolean;
  readonly occurrence: { readonly publicSlideKey: string; readonly occurrenceSeq: number };
  readonly cards: readonly StageCardView[];
  readonly publicCardRevision: string;
  readonly tombstoneWatermark: string;
  readonly tombstoneRetentionMs: number;
}

export interface StageAppliedReceiptView {
  readonly status: "STAGE_APPLIED";
  readonly commandId: string;
  readonly presentationSessionEpoch: string;
  readonly displayBindingEpoch: string;
  readonly publicPlaybackRevision: string;
  readonly appliedAtMs: number;
}

export interface StageSubscription {
  close(): void;
  recordApplied?(event: StagePlaybackEvent): void;
}

export interface StageEventObserver {
  onPlayback(event: StagePlaybackEvent): void;
  onCard(event: StageCardEvent): void;
  onReceipt?(receipt: StageAppliedReceiptView): void;
  onProtocolError?(code: string): void;
  onClose(reason: string): void;
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

interface BrowserWebSocket extends EventTarget {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => BrowserWebSocket;

export interface StageSessionClient {
  createJoin(identity: DisplayIdentity, deckVersion: string): Promise<DisplayJoinView>;
  claim(join: DisplayJoinView): Promise<void>;
  snapshot(pins?: StageSnapshotView): Promise<StageSnapshotView>;
  subscribe(observer: StageEventObserver, timeoutMs?: number): Promise<StageSubscription>;
  subscribeRealtime?(observer: StageEventObserver, timeoutMs?: number): Promise<StageSubscription>;
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
  const deck = record(candidate?.deck);
  if (
    candidate === null ||
    occurrence === null ||
    typeof occurrence.publicSlideKey !== "string" ||
    typeof occurrence.occurrenceSeq !== "number" ||
    candidate.role !== "PUBLIC_STAGE" ||
    typeof candidate.stateHash !== "string" ||
    typeof candidate.presentationSessionId !== "string" ||
    typeof candidate.presentationSessionEpoch !== "string" ||
    typeof candidate.displayBindingEpoch !== "string" ||
    typeof candidate.publicPlaybackRevision !== "string" ||
    typeof candidate.blackout !== "boolean" ||
    deck === null ||
    typeof deck.deckVersion !== "string" ||
    typeof deck.manifestHash !== "string" ||
    !Array.isArray(deck.slides) ||
    !Array.isArray(candidate.cards) ||
    typeof candidate.publicCardRevision !== "string" ||
    typeof candidate.tombstoneWatermark !== "string" ||
    typeof candidate.tombstoneRetentionMs !== "number"
  ) {
    return null;
  }
  const deckSlides: StageSnapshotView["deckSlides"][number][] = [];
  for (const valueSlide of deck.slides) {
    const slide = record(valueSlide);
    const image = record(slide?.image);
    if (
      slide === null ||
      image === null ||
      typeof slide.publicSlideKey !== "string" ||
      typeof slide.ordinal !== "number" ||
      typeof slide.accessibilityLabel !== "string" ||
      typeof image.url !== "string" ||
      typeof image.contentHash !== "string"
    ) {
      return null;
    }
    deckSlides.push({
      publicSlideKey: slide.publicSlideKey,
      ordinal: slide.ordinal,
      imageUrl: image.url,
      imageContentHash: image.contentHash,
      accessibilityLabel: slide.accessibilityLabel,
    });
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
    const mode = card.mode === "LIVE" ? "LIVE" : "CURATED";
    const leaseExpiresAtMs =
      typeof card.leaseExpiresAtMs === "number"
        ? card.leaseExpiresAtMs
        : typeof card.expiresAtMs === "number" && mode === "LIVE"
          ? card.expiresAtMs
          : null;
    if (mode === "LIVE" && leaseExpiresAtMs === null) return null;
    const offlinePackage = record(card.offlinePackage);
    cards.push({
      projectionId: card.projectionId,
      status: card.status,
      mode,
      leaseExpiresAtMs,
      ...(offlinePackage !== null &&
      typeof offlinePackage.offlineDisplayAllowed === "boolean" &&
      typeof offlinePackage.localExpiresAtMs === "number" &&
      typeof offlinePackage.signature === "string"
        ? {
            offlinePackage: {
              offlineDisplayAllowed: offlinePackage.offlineDisplayAllowed,
              localExpiresAtMs: offlinePackage.localExpiresAtMs,
              signature: offlinePackage.signature,
              signatureVerified: false,
            },
          }
        : {}),
      claim: card.claim,
      supportSummary: card.supportSummary,
      sourceLabel: card.sourceLabel,
      publicCardRevision: card.publicCardRevision,
    });
  }
  return {
    role: "PUBLIC_STAGE",
    stateHash: candidate.stateHash,
    presentationSessionId: candidate.presentationSessionId,
    presentationSessionEpoch: candidate.presentationSessionEpoch,
    displayBindingEpoch: candidate.displayBindingEpoch,
    deckVersion: deck.deckVersion,
    manifestHash: deck.manifestHash,
    deckSlides,
    publicPlaybackRevision: candidate.publicPlaybackRevision,
    blackout: candidate.blackout,
    occurrence: {
      publicSlideKey: occurrence.publicSlideKey,
      occurrenceSeq: occurrence.occurrenceSeq,
    },
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
    typeof candidate.presentationSessionEpoch === "string" &&
    typeof candidate.displayBindingEpoch === "string" &&
    typeof candidate.acceptedControlRevision === "string" &&
    typeof candidate.publicPlaybackRevision === "string" &&
    typeof occurrence.publicSlideKey === "string" &&
    typeof occurrence.occurrenceSeq === "number" &&
    typeof candidate.blackout === "boolean"
    ? {
        commandId: candidate.commandId,
        presentationSessionEpoch: candidate.presentationSessionEpoch,
        displayBindingEpoch: candidate.displayBindingEpoch,
        acceptedControlRevision: candidate.acceptedControlRevision,
        publicPlaybackRevision: candidate.publicPlaybackRevision,
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
    const mode = candidate.mode === "LIVE" ? "LIVE" : "CURATED";
    const leaseExpiresAtMs =
      typeof candidate.leaseExpiresAtMs === "number"
        ? candidate.leaseExpiresAtMs
        : typeof candidate.expiresAtMs === "number" && mode === "LIVE"
          ? candidate.expiresAtMs
          : null;
    if (mode === "LIVE" && leaseExpiresAtMs === null) return null;
    const offlinePackage = record(candidate.offlinePackage);
    return {
      projectionId: candidate.projectionId,
      status: candidate.status,
      mode,
      leaseExpiresAtMs,
      ...(offlinePackage !== null &&
      typeof offlinePackage.offlineDisplayAllowed === "boolean" &&
      typeof offlinePackage.localExpiresAtMs === "number" &&
      typeof offlinePackage.signature === "string"
        ? {
            offlinePackage: {
              offlineDisplayAllowed: offlinePackage.offlineDisplayAllowed,
              localExpiresAtMs: offlinePackage.localExpiresAtMs,
              signature: offlinePackage.signature,
              signatureVerified: false,
            },
          }
        : {}),
      claim: candidate.claim,
      supportSummary: candidate.supportSummary,
      sourceLabel: candidate.sourceLabel,
      publicCardRevision: candidate.publicCardRevision,
    };
  }
  return null;
}

function appliedReceipt(value: unknown): StageAppliedReceiptView | null {
  const candidate = record(value);
  return candidate !== null &&
    candidate.status === "STAGE_APPLIED" &&
    typeof candidate.commandId === "string" &&
    typeof candidate.presentationSessionEpoch === "string" &&
    typeof candidate.displayBindingEpoch === "string" &&
    typeof candidate.publicPlaybackRevision === "string" &&
    typeof candidate.appliedAtMs === "number"
    ? {
        status: "STAGE_APPLIED",
        commandId: candidate.commandId,
        presentationSessionEpoch: candidate.presentationSessionEpoch,
        displayBindingEpoch: candidate.displayBindingEpoch,
        publicPlaybackRevision: candidate.publicPlaybackRevision,
        appliedAtMs: candidate.appliedAtMs,
      }
    : null;
}

function parseStreamMessage(
  event: Event,
):
  | Readonly<{ kind: "PLAYBACK"; payload: StagePlaybackEvent }>
  | Readonly<{ kind: "CARD"; payload: StageCardEvent }>
  | Readonly<{ kind: "RECEIPT"; payload: StageAppliedReceiptView }>
  | Readonly<{ kind: "ERROR"; code: string }>
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
  if (envelope?.kind === "PLAYBACK" || envelope?.kind === "COMMAND") {
    const payload = playback(envelope.payload);
    return payload === null ? null : { kind: "PLAYBACK", payload };
  }
  if (envelope?.kind === "RECEIPT") {
    const payload = appliedReceipt(envelope.payload);
    return payload === null ? null : { kind: "RECEIPT", payload };
  }
  if (envelope?.kind === "CARD") {
    const payload = cardEvent(envelope.payload);
    return payload === null ? null : { kind: "CARD", payload };
  }
  if (envelope?.kind === "ERROR") {
    const payload = record(envelope.payload);
    return payload !== null && typeof payload.code === "string"
      ? { kind: "ERROR", code: payload.code }
      : null;
  }
  if (envelope?.kind === "CLOSE") {
    const payload = record(envelope.payload);
    return payload !== null && typeof payload.reason === "string"
      ? { kind: "CLOSE", reason: payload.reason }
      : null;
  }
  return null;
}

const OFFLINE_DISPLAY_PUBLIC_KEY: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "bt2abKicLjB_DoIwd8C0nUzPIFcxcGgNm2yEyfu_KQw",
  y: "vRlUGKUPFAnH1axFaQu-kaNxDMpfj8ZDV1dvFGxH3NU",
  ext: true,
  key_ops: ["verify"],
};

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

export async function verifyOfflinePackage(card: StageCardView): Promise<StageCardView> {
  const offline = card.offlinePackage;
  if (offline === undefined) return card;
  const signature = base64UrlBytes(offline.signature);
  let signatureVerified = false;
  if (signature !== null) {
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        OFFLINE_DISPLAY_PUBLIC_KEY,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const signedPayload = JSON.stringify({
        projectionId: card.projectionId,
        offlineDisplayAllowed: offline.offlineDisplayAllowed,
        localExpiresAtMs: offline.localExpiresAtMs,
      });
      signatureVerified = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signature,
        new TextEncoder().encode(signedPayload),
      );
    } catch {
      signatureVerified = false;
    }
  }
  return {
    ...card,
    offlinePackage: { ...offline, signatureVerified },
  };
}

async function validSnapshotHash(value: unknown): Promise<boolean> {
  const candidate = record(value);
  if (candidate === null || typeof candidate.stateHash !== "string") return false;
  const expected = candidate.stateHash;
  const absoluteState = { ...candidate };
  delete absoluteState.stateHash;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(absoluteState)),
  );
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return actual === expected;
}

export function createStageSessionClient(
  baseUrl = "",
  eventSourceFactory: EventSourceFactory = (url) => new EventSource(url),
  webSocketFactory: WebSocketFactory = (url) => new WebSocket(url),
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
    async snapshot(pins) {
      const query = new URLSearchParams();
      if (pins !== undefined) {
        query.set("role", "PUBLIC_STAGE");
        query.set("presentationSessionEpoch", pins.presentationSessionEpoch);
        query.set("displayBindingEpoch", pins.displayBindingEpoch);
        query.set("deckVersion", pins.deckVersion);
        query.set("manifestHash", pins.manifestHash);
      }
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;
      const response = await fetch(`${baseUrl}/v1/snapshot${suffix}`, {
        credentials: "include",
      });
      const raw = await json(response);
      const body = snapshot(raw);
      if (!response.ok || body === null || !(await validSnapshotHash(raw))) {
        if (response.status === 409) throw new Error("RECONCILE_REQUIRED");
        throw new Error("Public snapshot is unavailable.");
      }
      return {
        ...body,
        cards: await Promise.all(body.cards.map(verifyOfflinePackage)),
      };
    },
    async subscribe(observer, timeoutMs = 5_000) {
      const source = eventSourceFactory(`${baseUrl}/v1/events`);
      const timeout = AbortSignal.timeout(timeoutMs);
      let opened = false;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        source.close();
        source.removeEventListener("message", onMessage);
        source.removeEventListener("error", onError);
      };
      const onMessage = (event: Event) => {
        const message = parseStreamMessage(event);
        if (message?.kind === "PLAYBACK") observer.onPlayback(message.payload);
        if (message?.kind === "CARD") observer.onCard(message.payload);
        if (message?.kind === "RECEIPT") observer.onReceipt?.(message.payload);
        if (message?.kind === "ERROR") observer.onProtocolError?.(message.code);
        if (message?.kind === "CLOSE") {
          observer.onClose(message.reason);
          close();
        }
      };
      const onError = () => {
        if (opened) {
          observer.onClose("NETWORK_ERROR");
          close();
        }
      };
      source.addEventListener("message", onMessage);
      source.addEventListener("error", onError);
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          opened = true;
          resolve();
        };
        source.addEventListener("open", onOpen, { once: true });
        timeout.addEventListener(
          "abort",
          () => {
            if (!opened) {
              close();
              reject(new Error(`Stage event channel did not open within ${timeoutMs}ms`));
            }
          },
          { once: true },
        );
      });
      return { close };
    },
    async subscribeRealtime(observer, timeoutMs = 5_000) {
      const realtimeUrl = new URL(
        `${baseUrl}/v1/realtime`,
        globalThis.location?.href ?? "http://localhost/",
      );
      realtimeUrl.protocol = realtimeUrl.protocol === "https:" ? "wss:" : "ws:";
      const source = webSocketFactory(realtimeUrl.href);
      const timeout = AbortSignal.timeout(timeoutMs);
      let opened = false;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        source.close();
        source.removeEventListener("message", onMessage);
        source.removeEventListener("error", onError);
        source.removeEventListener("close", onClose);
      };
      const onMessage = (event: Event) => {
        const message = parseStreamMessage(event);
        if (message?.kind === "PLAYBACK") observer.onPlayback(message.payload);
        if (message?.kind === "CARD") observer.onCard(message.payload);
        if (message?.kind === "RECEIPT") observer.onReceipt?.(message.payload);
        if (message?.kind === "ERROR") observer.onProtocolError?.(message.code);
        if (message?.kind === "CLOSE") {
          observer.onClose(message.reason);
          close();
        }
      };
      const onError = () => {
        observer.onClose("NETWORK_ERROR");
        close();
      };
      const onClose = () => {
        if (!closed) observer.onClose("NETWORK_ERROR");
        close();
      };
      source.addEventListener("message", onMessage);
      source.addEventListener("error", onError);
      source.addEventListener("close", onClose);
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          opened = true;
          resolve();
        };
        source.addEventListener("open", onOpen, { once: true });
        timeout.addEventListener(
          "abort",
          () => {
            if (!opened) {
              close();
              reject(new Error(`Stage realtime channel did not open within ${timeoutMs}ms`));
            }
          },
          { once: true },
        );
      });
      return {
        close,
        recordApplied(event) {
          if (source.readyState !== 1) throw new Error("Stage realtime channel is not open.");
          source.send(
            JSON.stringify({
              kind: "STAGE_APPLIED",
              payload: {
                commandId: event.commandId,
                displayBindingEpoch: event.displayBindingEpoch,
              },
            }),
          );
        },
      };
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

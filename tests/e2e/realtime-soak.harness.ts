import { type ChildProcessByStdio, spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

export interface RealtimeSoakEvidence {
  readonly profile: "venue-like-real-network-exact-event";
  readonly transport: "private-http+projection-wss+snapshot-http";
  readonly commandCount: number;
  readonly reconnectCount: number;
  readonly commandToStageAppliedP95Ms: number;
  readonly reconnectToSnapshotP95Ms: number;
  readonly observedVisibleEffects: number;
  readonly duplicateVisibleEffects: number;
  readonly staleEpochAcceptances: number;
  readonly staleCardResurrections: number;
  readonly liveLeaseMs: number;
  readonly silentPartitionExposureMs: number;
}

type ServiceProcess = ChildProcessByStdio<null, Readable, Readable>;
type JsonRecord = Record<string, unknown>;
type RuntimeSocket = WebSocket;
type RuntimeWebSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string> },
) => RuntimeSocket;

const RuntimeWebSocket = WebSocket as unknown as RuntimeWebSocketConstructor;
const privateOrigin = "http://127.0.0.1:44301";
const projectionOrigin = "http://127.0.0.1:44302";
const consoleOrigin = "http://127.0.0.1:44373";
const stageOrigin = "http://127.0.0.1:44374";
const serviceToken = "wp5-real-network-soak-token";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} is missing`);
  return value;
}

function percentile95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const value = ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
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
  AbortSignal.timeout(timeoutMs).addEventListener(
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

async function waitForOutput(stream: Readable, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const signal = AbortSignal.timeout(10_000);
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`process exited before emitting ${expected}: ${output}`));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error(`process did not emit ${expected}: ${output}`));
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function startProcess(
  command: readonly string[],
  environment: Record<string, string>,
  expectedOutput: string,
): Promise<ServiceProcess> {
  const executable = command[0];
  if (executable === undefined) throw new Error("empty process command");
  const child = spawn(executable, command.slice(1), {
    env: { ...globalThis.process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForOutput(child.stdout, expectedOutput);
    return child;
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
}

async function stopProcess(process: ServiceProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, "exit", { signal: AbortSignal.timeout(5_000) });
  if (globalThis.process.platform === "win32" && process.pid !== undefined) {
    const terminator = spawn("taskkill", ["/PID", String(process.pid), "/T", "/F"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    await once(terminator, "exit", { signal: AbortSignal.timeout(5_000) });
  } else {
    process.kill("SIGTERM");
  }
  await exited;
}

async function jsonRecord(response: Response): Promise<JsonRecord> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error(`expected JSON object from ${response.url}`);
  return body;
}

function privateHeaders(csrfToken?: string, cookie?: string): HeadersInit {
  return {
    origin: consoleOrigin,
    referer: `${consoleOrigin}/`,
    "content-type": "application/json",
    ...(csrfToken === undefined ? {} : { "x-csrf-token": csrfToken }),
    ...(cookie === undefined ? {} : { cookie }),
  };
}

async function privateMutation(
  path: string,
  body: unknown,
  csrfToken: string,
  cookie: string,
  expectedStatuses: readonly number[] = [200, 201, 202],
): Promise<{ response: Response; body: JsonRecord }> {
  const response = await fetch(`${privateOrigin}${path}`, {
    method: "POST",
    headers: privateHeaders(csrfToken, cookie),
    body: JSON.stringify(body),
  });
  const result = await jsonRecord(response);
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${path} failed (${response.status}): ${JSON.stringify(result)}`);
  }
  return { response, body: result };
}

interface ObservedStage {
  presentationSessionEpoch: string;
  displayBindingEpoch: string;
  publicPlaybackRevision: string;
  publicCardRevision: string;
  occurrence: { publicSlideKey: string; occurrenceSeq: number };
  blackout: boolean;
  cards: Set<string>;
  observedCommandIds: Set<string>;
  visibleMutationsByCommand: Map<string, number>;
  staleEpochFrames: number;
}

interface SocketController {
  socket: RuntimeSocket;
  close(): Promise<void>;
}

export async function runRealtimeSoak(): Promise<RealtimeSoakEvidence> {
  const processes: ServiceProcess[] = [];
  const temporaryRoot = process.env.TEMP ?? process.cwd();
  const privateSnapshotPath = join(temporaryRoot, "impromptu-r2-wp5-private.json");
  const projectionDatabasePath = join(temporaryRoot, "impromptu-r2-wp5-projection.json");
  rmSync(privateSnapshotPath, { force: true });
  rmSync(projectionDatabasePath, { force: true });
  const projectionEnvironment = {
    PRIVATE_BACKEND_ORIGIN: privateOrigin,
    PROJECTION_GATEWAY_HOST: "127.0.0.1",
    PROJECTION_GATEWAY_PORT: "44302",
    PROJECTION_DATABASE_PATH: projectionDatabasePath,
    SERVICE_AUTH_TOKEN: serviceToken,
    STAGE_ORIGIN: stageOrigin,
  };
  const privateEnvironment = {
    CONSOLE_ORIGIN: consoleOrigin,
    CONTROLLER_ACCOUNT_ID: "account_wp5",
    CONTROLLER_ACTOR_ID: "actor_wp5",
    CONTROLLER_AUTHORIZATION_CODE: "wp5-code",
    TAKEOVER_ACTOR_ID: "actor_wp5_takeover",
    TAKEOVER_AUTHORIZATION_CODE: "wp5-takeover-code",
    PRIVATE_BACKEND_HOST: "127.0.0.1",
    PRIVATE_BACKEND_PORT: "44301",
    PRIVATE_SNAPSHOT_PATH: privateSnapshotPath,
    PROJECTION_GATEWAY_ORIGIN: projectionOrigin,
    SERVICE_AUTH_TOKEN: serviceToken,
  };
  let activeSocket: SocketController | null = null;
  try {
    processes.push(
      await startProcess(
        ["bun", "run", "services/projection-gateway/src/main.ts"],
        projectionEnvironment,
        "projection-gateway listening",
      ),
    );
    processes.push(
      await startProcess(
        ["bun", "run", "services/private-backend/src/main.ts"],
        privateEnvironment,
        "private-backend listening",
      ),
    );

    const signIn = await fetch(`${privateOrigin}/v1/account-sessions`, {
      method: "POST",
      headers: privateHeaders(),
      body: JSON.stringify({ authorizationCode: "wp5-code" }),
    });
    const signInBody = await jsonRecord(signIn);
    const accountCookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
    if (!signIn.ok || accountCookie === undefined) throw new Error("controller sign-in failed");
    const csrfToken = requireString(signInBody, "csrfToken");
    const uploaded = (
      await privateMutation(
        "/v1/deck-artifacts",
        { title: "WP5 real network soak", content: "venue soak deck" },
        csrfToken,
        accountCookie,
      )
    ).body;
    if (!isRecord(uploaded.privateDeck) || !isRecord(uploaded.publicDeck)) {
      throw new Error("deck artifacts missing");
    }
    const privateDeck = structuredClone(uploaded.privateDeck);
    const publicDeck = structuredClone(uploaded.publicDeck);
    if (!Array.isArray(privateDeck.slides) || !Array.isArray(publicDeck.slides)) {
      throw new Error("deck slides missing");
    }
    const firstPublicSlide = publicDeck.slides[0];
    if (!isRecord(firstPublicSlide)) throw new Error("first public slide missing");
    const firstSlideKey = requireString(firstPublicSlide, "publicSlideKey");
    const secondSlideKey = "slide_wp5_second";
    privateDeck.slides.push({
      privateSlideId: "private_slide_wp5_second",
      publicSlideKey: secondSlideKey,
      ordinal: 2,
      speakerNotes: "",
      extractedText: "second public slide",
      sourceAssetIds: ["asset_wp5_second"],
    });
    publicDeck.slides.push({
      publicSlideKey: secondSlideKey,
      ordinal: 2,
      image: {
        url: "https://public.example.test/slides/wp5-second.png",
        contentHash: "d".repeat(64),
        width: 1920,
        height: 1080,
      },
      accessibilityLabel: "Second soak slide",
    });
    const deckVersion = requireString(publicDeck, "deckVersion");
    const manifestHash = requireString(publicDeck, "manifestHash");
    const created = (
      await privateMutation(
        "/v1/presentation-sessions",
        { privateDeck, publicDeck },
        csrfToken,
        accountCookie,
      )
    ).body;
    if (!isRecord(created.lifecycle)) throw new Error("presentation lifecycle missing");
    const presentationSessionId = requireString(created.lifecycle, "presentationSessionId");

    const joinResponse = await fetch(`${projectionOrigin}/v1/display-joins`, {
      method: "POST",
      headers: {
        origin: stageOrigin,
        referer: `${stageOrigin}/`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayId: "display_wp5_soak",
        displayFingerprint: "wp5-stage-fingerprint",
        deckVersion,
      }),
    });
    const join = await jsonRecord(joinResponse);
    if (!joinResponse.ok) throw new Error("display join failed");
    await privateMutation(
      "/v1/display-bindings",
      {
        presentationSessionId,
        displayJoinId: requireString(join, "displayJoinId"),
        expectedDisplayBindingEpoch: "dbe_0",
        expectedDeckVersion: deckVersion,
        approvedDisplayId: requireString(join, "displayId"),
        approvedDisplayFingerprint: requireString(join, "displayFingerprint"),
      },
      csrfToken,
      accountCookie,
    );
    const claimResponse = await fetch(`${projectionOrigin}/v1/display-session`, {
      method: "POST",
      headers: {
        origin: stageOrigin,
        referer: `${stageOrigin}/display/display_wp5_soak`,
        "content-type": "application/json",
      },
      body: JSON.stringify(join),
    });
    const claimed = await jsonRecord(claimResponse);
    const displayCookie = claimResponse.headers.get("set-cookie")?.split(";", 1)[0];
    if (!claimResponse.ok || displayCookie === undefined) throw new Error("display claim failed");
    if (!isRecord(claimed.binding)) throw new Error("display binding missing");

    const observed: ObservedStage = {
      presentationSessionEpoch: requireString(claimed.binding, "presentationSessionEpoch"),
      displayBindingEpoch: requireString(claimed.binding, "displayBindingEpoch"),
      publicPlaybackRevision: "pbr_0",
      publicCardRevision: "pcr_0",
      occurrence: { publicSlideKey: firstSlideKey, occurrenceSeq: 1 },
      blackout: false,
      cards: new Set(),
      observedCommandIds: new Set(),
      visibleMutationsByCommand: new Map(),
      staleEpochFrames: 0,
    };
    const receiptSignals = new Map<string, ReturnType<typeof exactSignal<JsonRecord>>>();
    let cardPublished: ReturnType<typeof exactSignal<void>> | null = null;
    let leaseHidden: ReturnType<typeof exactSignal<number>> | null = null;
    let partitionStartedAt = 0;

    const observeFrame = (socket: RuntimeSocket, input: unknown) => {
      if (!isRecord(input) || !isRecord(input.payload)) return;
      const payload = input.payload;
      if (input.kind === "COMMAND") {
        const commandId = requireString(payload, "commandId");
        const presentationSessionEpoch = requireString(payload, "presentationSessionEpoch");
        const displayBindingEpoch = requireString(payload, "displayBindingEpoch");
        if (
          presentationSessionEpoch !== observed.presentationSessionEpoch ||
          displayBindingEpoch !== observed.displayBindingEpoch
        ) {
          observed.staleEpochFrames += 1;
          return;
        }
        const sendApplied = () =>
          socket.send(
            JSON.stringify({
              kind: "STAGE_APPLIED",
              payload: { commandId, displayBindingEpoch },
            }),
          );
        if (observed.observedCommandIds.has(commandId)) {
          sendApplied();
          return;
        }
        observed.observedCommandIds.add(commandId);
        if (!isRecord(payload.occurrence)) throw new Error("command occurrence missing");
        const nextOccurrence = {
          publicSlideKey: requireString(payload.occurrence, "publicSlideKey"),
          occurrenceSeq: Number(payload.occurrence.occurrenceSeq),
        };
        const nextBlackout = payload.blackout === true;
        if (
          nextOccurrence.publicSlideKey !== observed.occurrence.publicSlideKey ||
          nextOccurrence.occurrenceSeq !== observed.occurrence.occurrenceSeq ||
          nextBlackout !== observed.blackout
        ) {
          observed.visibleMutationsByCommand.set(
            commandId,
            (observed.visibleMutationsByCommand.get(commandId) ?? 0) + 1,
          );
          observed.occurrence = nextOccurrence;
          observed.blackout = nextBlackout;
        }
        observed.publicPlaybackRevision = requireString(payload, "publicPlaybackRevision");
        sendApplied();
      }
      if (input.kind === "RECEIPT") {
        const commandId = requireString(payload, "commandId");
        receiptSignals.get(commandId)?.resolve(payload);
        receiptSignals.delete(commandId);
      }
      if (input.kind === "CARD" && payload.status === "PUBLISHED") {
        const projectionId = requireString(payload, "projectionId");
        observed.cards.add(projectionId);
        observed.publicCardRevision = requireString(payload, "publicCardRevision");
        const leaseExpiresAtMs = Number(payload.leaseExpiresAtMs);
        cardPublished?.resolve();
        AbortSignal.timeout(Math.max(0, leaseExpiresAtMs - Date.now())).addEventListener(
          "abort",
          () => {
            observed.cards.delete(projectionId);
            leaseHidden?.resolve(performance.now() - partitionStartedAt);
          },
          { once: true },
        );
      }
    };

    const openSocket = async (): Promise<SocketController> => {
      const opened = exactSignal<void>("WSS open", 2_000);
      const socket = new RuntimeWebSocket(`${projectionOrigin.replace("http", "ws")}/v1/realtime`, {
        headers: { Origin: stageOrigin, Cookie: displayCookie },
      });
      socket.addEventListener("open", () => opened.resolve());
      socket.addEventListener("message", (event) => {
        const decoded: unknown = JSON.parse(String(event.data));
        observeFrame(socket, decoded);
      });
      await opened.promise;
      return {
        socket,
        async close() {
          const runtimeSocket = socket as RuntimeSocket & { terminate?: () => void };
          if (runtimeSocket.terminate !== undefined) {
            runtimeSocket.terminate();
            return;
          }
          const closed = exactSignal<void>("WSS close", 2_000);
          socket.addEventListener("close", () => closed.resolve(), { once: true });
          socket.close();
          await closed.promise;
        },
      };
    };
    activeSocket = await openSocket();

    const commandLatencies: number[] = [];
    for (let index = 1; index <= 500; index += 1) {
      const commandId = `cmd_soak_${index}`;
      const receipt = exactSignal<JsonRecord>(commandId, 300);
      receiptSignals.set(commandId, receipt);
      const startedAt = performance.now();
      const command = {
        presentationSessionId,
        commandId,
        publicSlideKey: index % 2 === 0 ? secondSlideKey : firstSlideKey,
        displayBindingEpoch: observed.displayBindingEpoch,
        baseRevision: `cr_${index - 1}`,
      };
      const mutation = privateMutation("/v1/playback/slide-set", command, csrfToken, accountCookie);
      await Promise.all([mutation, receipt.promise]);
      commandLatencies.push(performance.now() - startedAt);
      if (index % 10 === 0) {
        await privateMutation(
          "/v1/playback/slide-set",
          command,
          csrfToken,
          accountCookie,
          [202, 409],
        );
      }
    }
    await privateMutation(
      "/v1/playback/slide-set",
      {
        presentationSessionId,
        commandId: "cmd_stale_epoch_probe",
        publicSlideKey: firstSlideKey,
        displayBindingEpoch: "dbe_0",
        baseRevision: "cr_500",
      },
      csrfToken,
      accountCookie,
      [409],
    );

    const reconnectLatencies: number[] = [];
    const readPinnedSnapshot = async () => {
      const query = new URLSearchParams({
        role: "PUBLIC_STAGE",
        presentationSessionEpoch: observed.presentationSessionEpoch,
        displayBindingEpoch: observed.displayBindingEpoch,
        deckVersion,
        manifestHash,
      });
      const response = await fetch(`${projectionOrigin}/v1/snapshot?${query}`, {
        headers: { origin: stageOrigin, cookie: displayCookie },
      });
      const snapshot = await jsonRecord(response);
      if (!response.ok) throw new Error(`snapshot failed: ${JSON.stringify(snapshot)}`);
      return snapshot;
    };
    for (let index = 0; index < 49; index += 1) {
      await activeSocket.close();
      const startedAt = performance.now();
      activeSocket = await openSocket();
      const snapshot = await readPinnedSnapshot();
      const revision = Number(requireString(snapshot, "publicPlaybackRevision").slice(4));
      const observedRevision = Number(observed.publicPlaybackRevision.slice(4));
      if (revision < observedRevision) {
        throw new Error(
          `reconnect attempted blind stale overwrite: snapshot=${revision}, observed=${observedRevision}`,
        );
      }
      reconnectLatencies.push(performance.now() - startedAt);
    }
    const mismatch = await fetch(
      `${projectionOrigin}/v1/snapshot?${new URLSearchParams({
        role: "PUBLIC_STAGE",
        presentationSessionEpoch: observed.presentationSessionEpoch,
        displayBindingEpoch: observed.displayBindingEpoch,
        deckVersion,
        manifestHash: "f".repeat(64),
      })}`,
      { headers: { origin: stageOrigin, cookie: displayCookie } },
    );
    const mismatchBody = await jsonRecord(mismatch);
    if (mismatch.status !== 409 || mismatchBody.outcome !== "RECONCILE_REQUIRED") {
      throw new Error("manifest mismatch did not require reconcile");
    }

    const liveLeaseMs = 250;
    cardPublished = exactSignal<void>("live-card-published", 2_000);
    leaseHidden = exactSignal<number>("live-card-lease-hidden", 3_000);
    const publishedAtMs = Date.now();
    const publishResponse = await fetch(`${projectionOrigin}/internal/cards`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        presentationSessionId,
        event: {
          projectionId: "projection_live_soak",
          status: "PUBLISHED",
          mode: "LIVE",
          leaseExpiresAtMs: publishedAtMs + liveLeaseMs,
          publicationPolicyVersion: "publication-policy-soak-1",
          cardVersion: "card-version-soak-1",
          liveBinding: {
            presentationSessionEpoch: observed.presentationSessionEpoch,
            publicSlideOccurrence: observed.occurrence,
            publicationPolicyVersion: "publication-policy-soak-1",
            cardVersion: "card-version-soak-1",
          },
          claim: "Leased live card",
          supportSummary: "Real partition probe",
          sourceLabel: "Public source",
          publishedAtMs,
          expiresAtMs: publishedAtMs + liveLeaseMs,
          publicCardRevision: "pcr_1",
          deckVersion,
          manifestHash,
          occurrence: observed.occurrence,
        },
      }),
    });
    if (!publishResponse.ok) throw new Error("live card publish failed");
    await cardPublished.promise;
    partitionStartedAt = performance.now();
    await activeSocket.close();
    const silentPartitionExposureMs = await leaseHidden.promise;
    const reconnectStartedAt = performance.now();
    activeSocket = await openSocket();
    const partitionSnapshot = await readPinnedSnapshot();
    reconnectLatencies.push(performance.now() - reconnectStartedAt);
    if (!Array.isArray(partitionSnapshot.cards)) throw new Error("snapshot cards missing");
    for (const card of partitionSnapshot.cards) {
      if (isRecord(card)) observed.cards.add(requireString(card, "projectionId"));
    }
    const staleCardResurrections = observed.cards.has("projection_live_soak") ? 1 : 0;

    const visibleEffectCounts = [...observed.visibleMutationsByCommand.values()];
    const duplicateVisibleEffects = visibleEffectCounts.reduce(
      (total, count) => total + Math.max(0, count - 1),
      0,
    );
    return {
      profile: "venue-like-real-network-exact-event",
      transport: "private-http+projection-wss+snapshot-http",
      commandCount: 500,
      reconnectCount: 50,
      commandToStageAppliedP95Ms: percentile95(commandLatencies),
      reconnectToSnapshotP95Ms: percentile95(reconnectLatencies),
      observedVisibleEffects: visibleEffectCounts.reduce((total, count) => total + count, 0),
      duplicateVisibleEffects,
      staleEpochAcceptances: observed.staleEpochFrames,
      staleCardResurrections,
      liveLeaseMs,
      silentPartitionExposureMs: Math.round(silentPartitionExposureMs * 1_000) / 1_000,
    };
  } finally {
    await activeSocket?.close().catch(() => undefined);
    for (const process of processes.toReversed()) await stopProcess(process);
    rmSync(privateSnapshotPath, { force: true });
    rmSync(projectionDatabasePath, { force: true });
  }
}

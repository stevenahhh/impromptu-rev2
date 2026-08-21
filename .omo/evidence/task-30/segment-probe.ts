/**
 * WP5 soak segment probe: measures one command round trip in segments.
 *
 * Client-side segments (per command):
 *   postToCommandMs     POST /v1/playback/slide-set start -> COMMAND frame on stage socket
 *   appliedToReceiptMs  STAGE_APPLIED sent -> RECEIPT frame received
 *   postToResponseMs    POST start -> 202 response headers+body consumed
 *   totalMs             max(response, receipt) - start (matches soak commandLatencies)
 *
 * Server-side segments come from the services' http_request logs (durationMs per path),
 * captured from child stdout and joined per command index.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

type ServiceProcess = ChildProcessByStdio<null, Readable, Readable>;

const COMMAND_COUNT = Number(process.env.PROBE_COMMANDS ?? "150");
const privateOrigin = "http://127.0.0.1:44301";
const projectionOrigin = "http://127.0.0.1:44302";
const consoleOrigin = "http://127.0.0.1:44373";
const stageOrigin = "http://127.0.0.1:44374";
const serviceToken = "wp5-real-network-soak-token";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} is missing`);
  return value;
}

async function waitForOutput(stream: Readable, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const signal = AbortSignal.timeout(15_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`exited before ${expected}: ${output}`));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error(`no ${expected}: ${output}`));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      signal.removeEventListener("abort", onAbort);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function stopProcess(process: ServiceProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, "exit", { signal: AbortSignal.timeout(5_000) });
  process.kill("SIGTERM");
  await exited;
}

interface LogLine {
  timestampMs: number;
  path: string;
  durationMs: number;
  status: number;
}

function collectLogs(buffer: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const line of buffer.split("\n")) {
    if (!line.includes("http_request")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed.path === "string") {
        lines.push({
          timestampMs: Number(parsed.timestampMs),
          path: parsed.path,
          durationMs: Number(parsed.durationMs),
          status: Number(parsed.status),
        });
      }
    } catch {
      // ignore partial lines
    }
  }
  return lines;
}

function stats(samples: readonly number[]): Record<string, number> {
  const ordered = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => ordered[Math.min(ordered.length - 1, Math.floor(q * ordered.length))];
  return {
    n: samples.length,
    mean: Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 100) / 100,
    p50: Math.round(pick(0.5) * 100) / 100,
    p95: Math.round(ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] * 100) / 100,
    max: Math.round((ordered.at(-1) ?? 0) * 100) / 100,
  };
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "impromptu-wp5-probe-"));
const privateStateKey = join(temporaryRoot, "probe-private.json");
const projectionStateKey = join(temporaryRoot, "probe-projection.json");
const deckStagingRoot = join(temporaryRoot, "staging");
const deckArtifactRoot = join(temporaryRoot, "artifacts");
mkdirSync(deckStagingRoot, { recursive: true });
mkdirSync(deckArtifactRoot, { recursive: true });
rmSync(privateStateKey, { force: true });
rmSync(projectionStateKey, { force: true });

const processes: ServiceProcess[] = [];
const outputs: string[] = [];
try {
  const projectionEnvironment = {
    PRIVATE_BACKEND_ORIGIN: privateOrigin,
    PROJECTION_GATEWAY_HOST: "127.0.0.1",
    PROJECTION_GATEWAY_PORT: "44302",
    PROJECTION_GATEWAY_STATE_KEY: projectionStateKey,
    PROJECTION_CONNECTION_RATE_LIMIT_CAPACITY: "10000",
    PROJECTION_CONNECTION_RATE_LIMIT_REFILL_PER_SECOND: "10000",
    PROJECTION_PUBLIC_RATE_LIMIT_CAPACITY: "10000",
    PROJECTION_PUBLIC_RATE_LIMIT_REFILL_PER_SECOND: "10000",
    SERVICE_AUTH_TOKEN: serviceToken,
    STAGE_ORIGIN: stageOrigin,
    DECK_ARTIFACT_ROOT: deckArtifactRoot,
  };
  const privateEnvironment = {
    CONSOLE_ORIGIN: consoleOrigin,
    CONTROLLER_ACCOUNT_ID: "account_wp5",
    CONTROLLER_USERNAME: "wp5controller",
    CONTROLLER_PASSWORD: "wp5-controller-password",
    CHAT_MODEL_API_KEY: "e2e-provider-key",
    EMBEDDING_MODEL_API_KEY: "e2e-provider-key",
    CHAT_MODEL_BASE_URL: "https://models.example.test/v1",
    EMBEDDING_MODEL_BASE_URL: "https://embeddings.example.test/v1",
    EMBEDDING_MODEL: "embedding-test",
    RERANK_MODEL: "rerank-test",
    LLM_MODEL: "llm-test",
    VERIFIER_MODEL: "verifier-test",
    PRIVATE_BACKEND_HOST: "127.0.0.1",
    PRIVATE_BACKEND_PORT: "44301",
    PRIVATE_PREPARED_EVIDENCE_STATE_KEY: privateStateKey,
    PROJECTION_GATEWAY_ORIGIN: projectionOrigin,
    SERVICE_AUTH_TOKEN: serviceToken,
    DECK_STAGING_ROOT: deckStagingRoot,
    DECK_ARTIFACT_ROOT: deckArtifactRoot,
  };
  for (const [command, environment, expected] of [
    [
      ["bun", "run", "services/projection-gateway/src/main.ts"],
      projectionEnvironment,
      "projection-gateway listening",
    ],
    [
      ["bun", "run", "services/private-backend/src/main.ts"],
      privateEnvironment,
      "private-backend listening",
    ],
  ] as const) {
    const child = spawn(command[0], command.slice(1), {
      env: { ...globalThis.process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: { text: string } = { text: "" };
    child.stdout.on("data", (chunk: Buffer) => {
      output.text += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output.text += chunk.toString("utf8");
    });
    outputs.push(output);
    processes.push(child);
    await waitForOutput(child.stdout, expected);
  }

  const headers = {
    origin: consoleOrigin,
    referer: `${consoleOrigin}/`,
    "content-type": "application/json",
  };
  const signIn = await fetch(`${privateOrigin}/v1/account-sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username: "wp5controller", password: "wp5-controller-password" }),
  });
  const signInBody: unknown = await signIn.json();
  const accountCookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
  if (!signIn.ok || accountCookie === undefined || !isRecord(signInBody)) {
    throw new Error("sign-in failed");
  }
  const csrfToken = requireString(signInBody, "csrfToken");
  const authHeaders = {
    ...headers,
    "x-csrf-token": csrfToken,
    cookie: accountCookie,
  };

  const uploaded: unknown = await (
    await fetch(`${privateOrigin}/v1/deck-artifacts`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "WP5 probe", content: "venue probe deck" }),
    })
  ).json();
  if (!isRecord(uploaded) || !isRecord(uploaded.privateDeck) || !isRecord(uploaded.publicDeck)) {
    throw new Error("deck upload failed");
  }
  const privateDeck = structuredClone(uploaded.privateDeck);
  const publicDeck = structuredClone(uploaded.publicDeck);
  if (!Array.isArray(privateDeck.slides) || !Array.isArray(publicDeck.slides)) {
    throw new Error("deck slides missing");
  }
  const firstPublicSlide = publicDeck.slides[0];
  if (!isRecord(firstPublicSlide)) throw new Error("first slide missing");
  const firstSlideKey = requireString(firstPublicSlide, "publicSlideKey");
  const secondSlideKey = "slide_probe_second";
  privateDeck.slides.push({
    privateSlideId: "private_slide_probe_second",
    publicSlideKey: secondSlideKey,
    ordinal: 2,
    speakerNotes: "",
    extractedText: "second slide",
    sourceAssetIds: ["asset_probe_second"],
  });
  publicDeck.slides.push({
    publicSlideKey: secondSlideKey,
    ordinal: 2,
    image: {
      url: "https://public.example.test/slides/probe-second.png",
      contentHash: "d".repeat(64),
      width: 1920,
      height: 1080,
    },
    accessibilityLabel: "Second probe slide",
  });
  const deckVersion = requireString(publicDeck, "deckVersion");

  const created: unknown = await (
    await fetch(`${privateOrigin}/v1/presentation-sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ privateDeck, publicDeck }),
    })
  ).json();
  if (!isRecord(created) || !isRecord(created.lifecycle)) throw new Error("session create failed");
  const presentationSessionId = requireString(created.lifecycle, "presentationSessionId");

  const joinResponse = await fetch(`${projectionOrigin}/v1/display-joins`, {
    method: "POST",
    headers: {
      origin: stageOrigin,
      referer: `${stageOrigin}/`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      displayId: "display_probe",
      displayFingerprint: "probe-stage-fingerprint",
      deckVersion,
    }),
  });
  const join: unknown = await joinResponse.json();
  if (!joinResponse.ok || !isRecord(join)) throw new Error("join failed");
  await fetch(`${privateOrigin}/v1/display-bindings`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      presentationSessionId,
      displayJoinId: requireString(join, "displayJoinId"),
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: deckVersion,
      approvedDisplayId: requireString(join, "displayId"),
      approvedDisplayFingerprint: requireString(join, "displayFingerprint"),
    }),
  });
  const claimResponse = await fetch(`${projectionOrigin}/v1/display-session`, {
    method: "POST",
    headers: {
      origin: stageOrigin,
      referer: `${stageOrigin}/display/display_probe`,
      "content-type": "application/json",
    },
    body: JSON.stringify(join),
  });
  const claimed: unknown = await claimResponse.json();
  const displayCookie = claimResponse.headers.get("set-cookie")?.split(";", 1)[0];
  if (!claimResponse.ok || displayCookie === undefined || !isRecord(claimed)) {
    throw new Error("claim failed");
  }
  const binding: unknown = (claimed as Record<string, unknown>).binding;
  if (!isRecord(binding)) throw new Error("binding missing");
  const displayBindingEpoch = requireString(binding, "displayBindingEpoch");

  let socketCommandResolve: (() => void) | null = null;
  let receiptResolve: (() => void) | null = null;
  const RuntimeWebSocket = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  const opened = new Promise<void>((resolve) => {
    const socket = new RuntimeWebSocket(`${projectionOrigin.replace("http", "ws")}/v1/realtime`, {
      headers: { Origin: stageOrigin, Cookie: displayCookie },
    });
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("message", (event) => {
      const decoded: unknown = JSON.parse(String(event.data));
      if (!isRecord(decoded) || !isRecord(decoded.payload)) return;
      if (decoded.kind === "COMMAND") {
        socket.send(
          JSON.stringify({
            kind: "STAGE_APPLIED",
            payload: {
              commandId: decoded.payload.commandId,
              displayBindingEpoch: decoded.payload.displayBindingEpoch,
            },
          }),
        );
        socketCommandResolve?.();
        socketCommandResolve = null;
      }
      if (decoded.kind === "RECEIPT") {
        receiptResolve?.();
        receiptResolve = null;
      }
    });
  });
  await opened;

  interface Sample {
    totalMs: number;
    postToCommandMs: number;
    appliedToReceiptMs: number;
    postToResponseMs: number;
  }
  const samples: Sample[] = [];
  for (let index = 1; index <= COMMAND_COUNT; index += 1) {
    const commandId = `cmd_probe_${index}`;
    const startedAt = performance.now();
    const commandPromise = new Promise<void>((resolve) => {
      socketCommandResolve = resolve;
    });
    const receiptPromise = new Promise<void>((resolve) => {
      receiptResolve = resolve;
    });
    const mutation = fetch(`${privateOrigin}/v1/playback/slide-set`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        presentationSessionId,
        commandId,
        publicSlideKey: index % 2 === 0 ? secondSlideKey : firstSlideKey,
        displayBindingEpoch,
        baseRevision: `cr_${index - 1}`,
      }),
    }).then(async (response) => {
      await response.json();
      return response.status;
    });
    await commandPromise;
    const commandAt = performance.now();
    await receiptPromise;
    const receiptAt = performance.now();
    const status = await mutation;
    const responseAt = performance.now();
    if (status !== 202) throw new Error(`command ${commandId} rejected: ${status}`);
    samples.push({
      totalMs: Math.max(responseAt, receiptAt) - startedAt,
      postToCommandMs: commandAt - startedAt,
      appliedToReceiptMs: receiptAt - commandAt,
      postToResponseMs: responseAt - startedAt,
    });
  }

  await stopProcess(processes[1]);
  processes.pop();
  await stopProcess(processes[0]);
  processes.pop();

  const gatewayLogs = collectLogs(outputs[0].text);
  const privateLogs = collectLogs(outputs[1].text);
  const byPath = (logs: LogLine[], path: string) =>
    stats(logs.filter((line) => line.path === path).map((line) => line.durationMs));

  const report = {
    commandCount: COMMAND_COUNT,
    client: {
      totalMs: stats(samples.map((sample) => sample.totalMs)),
      postToCommandMs: stats(samples.map((sample) => sample.postToCommandMs)),
      appliedToReceiptMs: stats(samples.map((sample) => sample.appliedToReceiptMs)),
      postToResponseMs: stats(samples.map((sample) => sample.postToResponseMs)),
    },
    server: {
      "private POST /v1/playback/slide-set": byPath(privateLogs, "/v1/playback/slide-set"),
      "gateway POST /internal/playback": byPath(gatewayLogs, "/internal/playback"),
      "private POST /internal/stage-applied": byPath(privateLogs, "/internal/stage-applied"),
      "gateway POST /internal/playback-applied": byPath(gatewayLogs, "/internal/playback-applied"),
    },
    rawSamples: samples,
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const process of processes.toReversed()) await stopProcess(process).catch(() => undefined);
  rmSync(temporaryRoot, { recursive: true, force: true });
}

// Task-34 observation driver: runs the real private-backend + projection-gateway on temp
// ports, uploads the format-neutral fixture, and calls POST /v1/recommendations N times.
// Readiness is consumed from each process's stdout; no sleeps. Logs stay inside task-34.
import { createServer, type AddressInfo } from "node:net";
import { mkdirSync, openSync, readFileSync, writeSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const OUT = import.meta.dir;
const RUNS = Number(process.env.OBSERVE_RUNS ?? "5");

function fail(message: string): never {
  throw new Error(message);
}

function dotenv(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  const text = readFileSync(path, "utf8");
  for (const raw of text.split("\n")) {
    if (!raw || raw.startsWith("#") || !raw.includes("=")) continue;
    const index = raw.indexOf("=");
    values[raw.slice(0, index).trim()] = raw
      .slice(index + 1)
      .trim()
      .replaceAll('"', "")
      .replaceAll("'", "");
  }
  return values;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

/** Accumulates stdout lines, mirrors them to a log file, and awaits substring matches. */
class LineCollector {
  #lines: string[] = [];
  #waiters: Array<() => void> = [];

  constructor(stream: ReadableStream<Uint8Array>, logFd: number) {
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk);
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          this.#lines.push(line);
          writeSync(logFd, `${line}\n`);
          index = buffer.indexOf("\n");
          for (const waiter of this.#waiters.splice(0)) waiter();
        }
      }
    })();
  }

  async wait(needle: string, timeoutMs = 60_000): Promise<void> {
    if (this.#lines.some((line) => line.includes(needle))) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((resolveWake) => this.#waiters.push(resolveWake));
      if (this.#lines.some((line) => line.includes(needle))) return;
    }
    fail(`timed out waiting for ${needle}; last lines:\n${this.#lines.slice(-20).join("\n")}`);
  }

  lastMatching(needle: string): string | undefined {
    return this.#lines.filter((line) => line.includes(needle)).at(-1);
  }
}

const env: Record<string, string> = { ...process.env, ...dotenv(`${ROOT}/.env.local`) };
env["CHAT_MODEL_API_KEY"] = env["OPENCODE_ZEN_API_KEY"] ?? "";
delete env["OPENCODE_ZEN_API_KEY"];
const shipped = dotenv(`${ROOT}/.env.example`);
for (const key of ["RERANK_MODEL", "LLM_MODEL", "VERIFIER_MODEL"]) env[key] = shipped[key] ?? "";
const [privatePort, projectionPort, consolePort, stagePort] = [
  await freePort(),
  await freePort(),
  await freePort(),
  await freePort(),
];
const nonce = crypto.randomUUID().slice(0, 16);
Object.assign(env, {
  CONSOLE_ORIGIN: `http://localhost:${consolePort}`,
  CONTROLLER_ACCOUNT_ID: "account_local_demo",
  CONTROLLER_USERNAME: "localdemo",
  CONTROLLER_PASSWORD: "demo-2026-password",
  DECK_ARTIFACT_ROOT: "/tmp",
  DECK_STAGING_ROOT: "/tmp",
  FFMPEG_BINARY_PATH: "/opt/homebrew/bin/ffmpeg",
  WHISPER_CPP_BINARY_PATH: "/opt/homebrew/bin/whisper-cli",
  WHISPER_CPP_MODEL_PATH: "/Users/gahn/.cache/whisper.cpp/ggml-small-q5_1.bin",
  CHAT_MODEL_BASE_URL: "https://opencode.ai/zen/go/v1",
  EMBEDDING_MODEL_API_KEY: "local-embedding-token",
  EMBEDDING_MODEL_BASE_URL: "https://127.0.0.1:8443/v1",
  EMBEDDING_MODEL: "embeddinggemma",
  NODE_EXTRA_CA_CERTS: "/Users/gahn/Library/Application Support/mkcert/rootCA.pem",
  PRIVATE_DATABASE_URL: "postgresql://impromptu_bootstrap@127.0.0.1:5432/impromptu_private",
  PRIVATE_BACKEND_PORT: String(privatePort),
  PRIVATE_PREPARED_EVIDENCE_STATE_KEY: `task34-${nonce}-private`,
  PROJECTION_GATEWAY_ORIGIN: `http://127.0.0.1:${projectionPort}`,
  PROJECTION_GATEWAY_PORT: String(projectionPort),
  PROJECTION_DATABASE_URL: "postgresql://impromptu_bootstrap@127.0.0.1:5432/impromptu_projection",
  PROJECTION_GATEWAY_STATE_KEY: `task34-${nonce}-projection`,
  PRIVATE_BACKEND_ORIGIN: `http://127.0.0.1:${privatePort}`,
  STAGE_ORIGIN: `http://localhost:${stagePort}`,
  SERVICE_AUTH_TOKEN: `task34-${nonce}`,
});
mkdirSync(OUT, { recursive: true });

const gatewayLogFd = openSync(`${OUT}/projection-gateway.log`, "w");
const privateLogFd = openSync(`${OUT}/private-backend.log`, "w");
const gateway = Bun.spawn(["bun", "run", "dev"], {
  cwd: `${ROOT}/services/projection-gateway`,
  env,
  stdout: "pipe",
  stderr: "pipe",
});
const backend = Bun.spawn(["bun", "run", "dev"], {
  cwd: `${ROOT}/services/private-backend`,
  env,
  stdout: "pipe",
  stderr: "pipe",
});
const gatewayLines = new LineCollector(gateway.stdout as ReadableStream<Uint8Array>, gatewayLogFd);
new LineCollector(gateway.stderr as ReadableStream<Uint8Array>, gatewayLogFd);
const backendLines = new LineCollector(backend.stdout as ReadableStream<Uint8Array>, privateLogFd);
new LineCollector(backend.stderr as ReadableStream<Uint8Array>, privateLogFd);

try {
  await gatewayLines.wait("listening");
  await backendLines.wait("listening");
  const origin = `http://127.0.0.1:${privatePort}`;
  const consoleOrigin = env["CONSOLE_ORIGIN"];

  const signIn = await fetch(`${origin}/v1/account-sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: consoleOrigin,
      referer: `${consoleOrigin}/sign-in`,
    },
    body: JSON.stringify({ username: "localdemo", password: "demo-2026-password" }),
  });
  if (signIn.status !== 201) fail(`sign-in returned ${signIn.status}: ${await signIn.text()}`);
  const session = (await signIn.json()) as Record<string, unknown>;
  const csrfToken = String(session.csrfToken);
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const form = new FormData();
  form.append(
    "file",
    new Blob([readFileSync(`${ROOT}/tests/fixtures/format-neutral-decks/korean-structural.pptx`)], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }),
    "korean-structural.pptx",
  );
  const upload = await fetch(`${origin}/v1/deck-uploads`, {
    method: "POST",
    headers: { origin: consoleOrigin, referer: `${consoleOrigin}/decks`, cookie, "x-csrf-token": csrfToken },
    body: form,
  });
  if (upload.status !== 201) fail(`upload returned ${upload.status}: ${await upload.text()}`);
  const receipt = (await upload.json()) as Record<string, unknown>;

  console.error("receipt:", JSON.stringify({deckVersion: receipt.deckVersion, manifestHash: receipt.manifestHash}));
  const outcomes: Array<Record<string, unknown>> = [];
  for (let index = 0; index < RUNS; index += 1) {
    const response = await fetch(`${origin}/v1/recommendations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: consoleOrigin,
        referer: `${consoleOrigin}/present`,
        cookie,
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({
        query: "형식 중립 근거 자료 2026",
        deckVersion: receipt.deckVersion,
        manifestHash: (receipt.privateDeck as Record<string, unknown>).manifestHash,
        maxResults: 3,
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (response.status !== 200) fail(`recommendation ${index} returned ${response.status}`);
    outcomes.push(body);
  }
  writeJson({ runs: RUNS, outcomes });
  console.log(JSON.stringify(outcomes.map((o) => o.outcome === "ABSTAIN" ? o.reason : o.outcome)));
} finally {
  for (const child of [backend, gateway]) child.kill("SIGTERM");
}

function writeJson(payload: unknown): void {
  writeFileSync(`${OUT}/observation.json`, `${JSON.stringify(payload, null, 2)}\n`);
}

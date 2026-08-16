import { type ChildProcessByStdio, spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

export interface PreparedEvidenceEvidence {
  readonly milestones: readonly string[];
  readonly acceptedCommandIds: readonly string[];
  readonly appliedCommandIds: readonly string[];
  readonly cardEvents: readonly string[];
  readonly connectedTombstoneLatencyMs: number;
  readonly reconnectActiveCardCount: number;
  readonly reconnectTombstoneStatuses: readonly string[];
  readonly browserStorageEntries: number;
  readonly tombstoneP95Ms: number;
  readonly latencySamples: number;
  readonly livePublicationRetractP95Ms: number;
  readonly livePublicationRetractSamples: number;
  readonly publicCorrelationMatches: number;
}

type ServiceProcess = ChildProcessByStdio<null, Readable, Readable>;
type JsonRecord = Record<string, unknown>;

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("ephemeral port missing");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

const privatePort = await availablePort();
const projectionPort = await availablePort();
const stagePort = await availablePort();
const chromeDebugPort = await availablePort();
const privateOrigin = `http://127.0.0.1:${privatePort}`;
const projectionOrigin = `http://127.0.0.1:${projectionPort}`;
const consoleOrigin = `http://127.0.0.1:${await availablePort()}`;
const stageOrigin = `http://127.0.0.1:${stagePort}`;
const serviceToken = "prepared-evidence-real-e2e-token";
const chromeExecutable = process.env.CHROME_EXECUTABLE_PATH ?? chromium.executablePath();

function trace(message: string): void {
  if (process.env.DEBUG_WP3_E2E === "true") console.log(`[wp3-e2e] ${message}`);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitForOutput(
  stream: Readable,
  expected: string,
  timeoutMs = 10_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const signal = AbortSignal.timeout(timeoutMs);
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
  cwd?: string,
  output: "stdout" | "stderr" = "stdout",
): Promise<ServiceProcess> {
  const executable = command[0];
  if (executable === undefined) throw new Error("empty process command");
  const process = spawn(executable, command.slice(1), {
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...globalThis.process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForOutput(output === "stdout" ? process.stdout : process.stderr, expectedOutput);
    return process;
  } catch (error) {
    const exited = once(process, "exit", { signal: AbortSignal.timeout(5_000) });
    process.kill();
    await exited;
    throw error;
  }
}

async function runCommand(command: readonly string[], cwd?: string): Promise<void> {
  const executable = command[0];
  if (executable === undefined) throw new Error("empty command");
  const child = spawn(executable, command.slice(1), {
    ...(cwd === undefined ? {} : { cwd }),
    env: globalThis.process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [code] = await once(child, "exit", { signal: AbortSignal.timeout(30_000) });
  if (code !== 0) {
    throw new Error(`command failed (${String(code)}): ${command.join(" ")}`);
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

function browserHeaders(csrfToken?: string, cookie?: string): HeadersInit {
  return {
    connection: "close",
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
): Promise<JsonRecord> {
  const response = await fetch(`${privateOrigin}${path}`, {
    method: "POST",
    headers: browserHeaders(csrfToken, cookie),
    body: JSON.stringify(body),
  });
  const result = await jsonRecord(response);
  if (!response.ok)
    throw new Error(`${path} failed (${response.status}): ${JSON.stringify(result)}`);
  return result;
}

async function installStageEventBuffer(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const records: Array<{ name: string; detail: unknown }> = [];
    Reflect.set(window, "__impromptuEventBuffer", records);
    for (const name of [
      "impromptu:display-join",
      "impromptu:playback-applied",
      "impromptu:card-event",
      "impromptu:channel-close",
    ]) {
      window.addEventListener(name, (event) => {
        records.push({ name, detail: event instanceof CustomEvent ? event.detail : null });
      });
    }
    Reflect.set(window, "__impromptuEventWaiters", new Map<string, Promise<unknown>>());
  });
}

interface BrowserEventCriteria {
  readonly name: string;
  readonly status?: string;
  readonly revision?: string;
  readonly commandId?: string;
}

async function prepareBrowserEvent(
  page: Page,
  criteria: BrowserEventCriteria,
  timeoutMs = 5_000,
): Promise<() => Promise<unknown>> {
  const waiterId = crypto.randomUUID();
  await page.evaluate(
    ({ criteria: expected, timeout, waiterId: id }) => {
      const matches = (detail: unknown) => {
        if (typeof detail !== "object" || detail === null) {
          return (
            expected.status === undefined &&
            expected.revision === undefined &&
            expected.commandId === undefined
          );
        }
        const candidate = detail as Record<string, unknown>;
        return (
          (expected.status === undefined || candidate.status === expected.status) &&
          (expected.revision === undefined || candidate.publicCardRevision === expected.revision) &&
          (expected.commandId === undefined || candidate.commandId === expected.commandId)
        );
      };
      const buffered = Reflect.get(window, "__impromptuEventBuffer") as Array<{
        name: string;
        detail: unknown;
      }>;
      const existing = buffered.find(
        (candidate) => candidate.name === expected.name && matches(candidate.detail),
      );
      const promise =
        existing === undefined
          ? new Promise<unknown>((resolve, reject) => {
              const signal = AbortSignal.timeout(timeout);
              const listener = (event: Event) => {
                const detail = event instanceof CustomEvent ? event.detail : null;
                if (matches(detail)) {
                  window.removeEventListener(expected.name, listener);
                  resolve(detail);
                }
              };
              window.addEventListener(expected.name, listener);
              signal.addEventListener(
                "abort",
                () => {
                  window.removeEventListener(expected.name, listener);
                  reject(new Error(`${expected.name} event timeout`));
                },
                { once: true },
              );
            })
          : Promise.resolve(existing.detail);
      const waiters = Reflect.get(window, "__impromptuEventWaiters") as Map<
        string,
        Promise<unknown>
      >;
      waiters.set(id, promise);
    },
    { criteria, timeout: timeoutMs, waiterId },
  );
  return () =>
    page.evaluate((id) => {
      const waiters = Reflect.get(window, "__impromptuEventWaiters") as Map<
        string,
        Promise<unknown>
      >;
      const promise = waiters.get(id);
      if (promise === undefined) throw new Error(`unknown browser waiter ${id}`);
      waiters.delete(id);
      return promise;
    }, waiterId);
}

async function prepareTextMutation(
  page: Page,
  text: string,
  visible: boolean,
  timeoutMs = 5_000,
): Promise<() => Promise<void>> {
  const waiterId = crypto.randomUUID();
  await page.evaluate(
    ({ expectedText, id, shouldBeVisible, timeout }) => {
      const present = () => document.body.textContent?.includes(expectedText) === true;
      const promise =
        present() === shouldBeVisible
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) => {
              const observer = new MutationObserver(() => {
                if (present() === shouldBeVisible) {
                  observer.disconnect();
                  resolve();
                }
              });
              observer.observe(document.body, {
                childList: true,
                characterData: true,
                subtree: true,
              });
              AbortSignal.timeout(timeout).addEventListener(
                "abort",
                () => {
                  observer.disconnect();
                  reject(new Error(`text mutation timeout: ${expectedText}`));
                },
                { once: true },
              );
            });
      const waiters = Reflect.get(window, "__impromptuEventWaiters") as Map<
        string,
        Promise<unknown>
      >;
      waiters.set(id, promise);
    },
    { expectedText: text, id: waiterId, shouldBeVisible: visible, timeout: timeoutMs },
  );
  return () =>
    page.evaluate((id) => {
      const waiters = Reflect.get(window, "__impromptuEventWaiters") as Map<
        string,
        Promise<unknown>
      >;
      const promise = waiters.get(id);
      if (promise === undefined) throw new Error(`unknown text waiter ${id}`);
      waiters.delete(id);
      return promise.then(() => undefined);
    }, waiterId);
}

function requireString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} is missing`);
  return value;
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 5_000,
): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  const next = await Promise.race([
    reader.read(),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("stream event timeout")), {
        once: true,
      });
    }),
  ]);
  if (next.done) throw new Error("stream closed before expected event");
  return new TextDecoder().decode(next.value);
}

function percentile95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const value = ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
  if (value === undefined) throw new Error("no latency samples");
  return value;
}

export async function runPreparedEvidenceE2E(): Promise<PreparedEvidenceEvidence> {
  const processes: ServiceProcess[] = [];
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let chromeProcess: ServiceProcess | null = null;
  let chromeExited: Promise<unknown[]> | null = null;
  const temporaryRoot = process.env.TEMP ?? process.cwd();
  const profilePath = join(temporaryRoot, `impromptu-r2-wp3-clean-stage-${process.pid}`);
  const privateSnapshotPath = join(
    temporaryRoot,
    `impromptu-r2-wp3-private-snapshot-${process.pid}.json`,
  );
  const projectionDatabasePath = join(
    temporaryRoot,
    `impromptu-r2-wp3-projection-database-${process.pid}.json`,
  );
  rmSync(profilePath, { force: true, recursive: true });
  rmSync(privateSnapshotPath, { force: true });
  rmSync(projectionDatabasePath, { force: true });
  const projectionEnvironment = {
    PRIVATE_BACKEND_ORIGIN: privateOrigin,
    PROJECTION_GATEWAY_HOST: "127.0.0.1",
    PROJECTION_GATEWAY_PORT: String(projectionPort),
    PROJECTION_DATABASE_PATH: projectionDatabasePath,
    SERVICE_AUTH_TOKEN: serviceToken,
    STAGE_ORIGIN: stageOrigin,
  };
  const privateEnvironment = {
    CONSOLE_ORIGIN: consoleOrigin,
    CONTROLLER_ACCOUNT_ID: "account_e2e",
    CONTROLLER_ACTOR_ID: "actor_e2e",
    CONTROLLER_AUTHORIZATION_CODE: "e2e-code",
    TAKEOVER_ACTOR_ID: "actor_e2e_takeover",
    TAKEOVER_AUTHORIZATION_CODE: "e2e-takeover-code",
    PRIVATE_BACKEND_HOST: "127.0.0.1",
    PRIVATE_BACKEND_PORT: String(privatePort),
    PRIVATE_SNAPSHOT_PATH: privateSnapshotPath,
    PROJECTION_GATEWAY_ORIGIN: projectionOrigin,
    SERVICE_AUTH_TOKEN: serviceToken,
  };
  try {
    let projectionProcess = await startProcess(
      ["bun", "run", "services/projection-gateway/src/main.ts"],
      projectionEnvironment,
      "projection-gateway listening",
    );
    processes.push(projectionProcess);
    let privateProcess = await startProcess(
      ["bun", "run", "services/private-backend/src/main.ts"],
      privateEnvironment,
      "private-backend listening",
    );
    processes.push(privateProcess);
    await runCommand(["bun", "run", "build"], "apps/stage");
    processes.push(
      await startProcess(
        ["bun", "run", "tests/e2e/stage-origin.ts"],
        {
          PROJECTION_GATEWAY_ORIGIN: projectionOrigin,
          TOPOLOGY_STAGE_PORT: String(stagePort),
        },
        "stage-origin listening",
      ),
    );

    trace("processes-ready");
    const signIn = await fetch(`${privateOrigin}/v1/account-sessions`, {
      method: "POST",
      headers: browserHeaders(),
      body: JSON.stringify({ authorizationCode: "e2e-code" }),
    });
    const signInBody = await jsonRecord(signIn);
    const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
    const csrfToken = requireString(signInBody, "csrfToken");
    if (!signIn.ok || cookie === undefined) throw new Error("real controller sign-in failed");

    const upload = await privateMutation(
      "/v1/deck-artifacts",
      { title: "Prepared evidence browser E2E", content: "clean prepared deck upload" },
      csrfToken,
      cookie,
    );
    const privateDeck = upload.privateDeck;
    const publicDeck = upload.publicDeck;
    if (!isRecord(privateDeck) || !isRecord(publicDeck))
      throw new Error("upload artifacts missing");
    const sourceHash = requireString(upload, "sourceHash");
    const deckVersion = requireString(publicDeck, "deckVersion");
    const manifestHash = requireString(publicDeck, "manifestHash");
    const slides = publicDeck.slides;
    if (!Array.isArray(slides) || !isRecord(slides[0])) throw new Error("public slide missing");
    const publicSlideKey = requireString(slides[0], "publicSlideKey");
    trace("upload-ready");
    const created = await privateMutation(
      "/v1/presentation-sessions",
      { privateDeck, publicDeck },
      csrfToken,
      cookie,
    );
    const lifecycle = created.lifecycle;
    const authority = created.authority;
    if (!isRecord(lifecycle) || !isRecord(authority))
      throw new Error("presentation response invalid");
    const presentationSessionId = requireString(lifecycle, "presentationSessionId");
    const authorityId = requireString(authority, "authorityId");

    trace("presentation-ready");
    chromeProcess = await startProcess(
      [
        chromeExecutable,
        "--headless=new",
        "--no-first-run",
        `--remote-debugging-port=${chromeDebugPort}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${profilePath}`,
        "about:blank",
      ],
      {},
      "DevTools listening",
      undefined,
      "stderr",
    );
    chromeExited = once(chromeProcess, "exit");
    processes.push(chromeProcess);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${chromeDebugPort}`);
    context = browser.contexts()[0] ?? null;
    if (context === null) throw new Error("Chrome did not expose its clean profile context");
    trace("chrome-ready");
    await installStageEventBuffer(context);
    const page = context.pages()[0] ?? (await context.newPage());
    if (process.env.DEBUG_WP3_E2E === "true") {
      page.on("console", (message) => trace(`browser-console:${message.type()}:${message.text()}`));
      page.on("pageerror", (error) => trace(`browser-error:${error.message}`));
      page.on("requestfailed", (request) => trace(`request-failed:${request.url()}`));
      page.on("response", (response) => trace(`response:${response.status()}:${response.url()}`));
    }
    await page.goto(`${stageOrigin}/?deck=${encodeURIComponent(deckVersion)}`, {
      waitUntil: "domcontentloaded",
    });
    trace("stage-dom-ready");
    const waitJoin = await prepareBrowserEvent(page, { name: "impromptu:display-join" });
    const join = await waitJoin();
    trace("join-ready");
    if (!isRecord(join)) throw new Error("browser display join event invalid");
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
      cookie,
    );

    const eventChannel = page.waitForResponse(
      (response) => response.url().endsWith("/v1/events") && response.status() === 200,
      { timeout: 5_000 },
    );
    await page.getByRole("button", { name: "Continue after approval" }).click();
    await eventChannel;
    trace("event-channel-ready");
    const waitApplied = await prepareBrowserEvent(page, {
      name: "impromptu:playback-applied",
      commandId: "cmd_e2e_absolute",
    });
    const slideSet = await privateMutation(
      "/v1/playback/slide-set",
      {
        presentationSessionId,
        commandId: "cmd_e2e_absolute",
        publicSlideKey,
        displayBindingEpoch: "dbe_1",
        baseRevision: "cr_0",
      },
      csrfToken,
      cookie,
    );
    const appliedReceipt = await waitApplied();
    trace("playback-applied");
    if (!isRecord(appliedReceipt)) throw new Error("browser applied receipt invalid");
    const acceptedCommandIds = [requireString(slideSet, "commandId")];
    const appliedCommandIds = [requireString(appliedReceipt, "commandId")];

    const cardEvents: string[] = [];
    const tombstoneLatencies: number[] = [];
    let publicCorrelationMatches = 0;
    for (let index = 0; index < 20; index += 1) {
      trace(`card-${index}-start`);
      const candidateId = `candidate_e2e_${index}`;
      const claim = `Prepared browser claim ${index}`;
      await privateMutation(
        "/v1/candidates/curated",
        {
          candidateId,
          candidateVersion: "candidate-version-1",
          provenance: "CURATED_PREAPPROVED",
          verdict: "SUPPORTED",
          claimText: claim,
          evidenceExcerpt: "Prepared support with approved rights.",
          privateSourceUri: `private://curated/${candidateId}`,
          causal: {
            presentationSessionId,
            presentationSessionEpoch: "pse_1",
            displayBindingEpoch: "dbe_1",
            deckVersion,
            manifestHash,
            occurrence: { publicSlideKey, occurrenceSeq: 1 },
            transcriptFinalId: null,
            source: {
              sourceId: `source_private_${index}`,
              revision: "source-revision-1",
              contentHash: sourceHash,
            },
            decisions: {
              acl: "acl-1",
              publicationPolicy: "publication-policy-1",
              rights: "rights-1",
              dlp: "dlp-1",
            },
          },
        },
        csrfToken,
        cookie,
      );
      const publishedRevision = `pcr_${index * 2 + 1}`;
      const tombstoneRevision = `pcr_${index * 2 + 2}`;
      const waitPublished = await prepareBrowserEvent(page, {
        name: "impromptu:card-event",
        revision: publishedRevision,
        status: "PUBLISHED",
      });
      const waitVisible = index === 0 ? await prepareTextMutation(page, claim, true) : null;
      const published = await privateMutation(
        "/v1/publications/approve",
        {
          presentationSessionId,
          candidateId,
          expectedCandidateRevision: "candrev_1",
          expectedPublicCardRevision: `pcr_${index * 2}`,
          authorityId,
          expiresAtMs: null,
        },
        csrfToken,
        cookie,
      );
      const publishedEvent = await waitPublished();
      await waitVisible?.();
      cardEvents.push(`${publishedRevision}:PUBLISHED`);
      const projectionId = requireString(published, "projectionId");
      if (!isRecord(publishedEvent)) throw new Error("published browser event invalid");
      const publicPayload = JSON.stringify(publishedEvent);
      const privateCorrelators = [
        candidateId,
        `source_private_${index}`,
        `private://curated/${candidateId}`,
        sourceHash,
      ];
      publicCorrelationMatches += privateCorrelators.filter((value) =>
        publicPayload.includes(value),
      ).length;
      if (publishedEvent.sourceLabel !== `Prepared source ${projectionId.slice(-8)}`) {
        publicCorrelationMatches += 1;
      }
      const status = index === 19 ? "EXPIRED" : "RETRACTED";
      const waitTombstone = await prepareBrowserEvent(page, {
        name: "impromptu:card-event",
        revision: tombstoneRevision,
        status,
      });
      const waitHidden = index === 0 ? await prepareTextMutation(page, claim, false) : null;
      const startedAt = performance.now();
      await privateMutation(
        "/v1/publications/terminate",
        {
          presentationSessionId,
          projectionId,
          expectedPublicCardRevision: publishedRevision,
          authorityId,
          status,
        },
        csrfToken,
        cookie,
      );
      await waitTombstone();
      await waitHidden?.();
      tombstoneLatencies.push(performance.now() - startedAt);
      cardEvents.push(`${tombstoneRevision}:${status}`);
      trace(`card-${index}-done`);
    }

    const liveRetractLatencies: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const publishedRevision = `pcr_${41 + index * 2}`;
      const tombstoneRevision = `pcr_${42 + index * 2}`;
      const projectionId = `projection_live_browser_${index}`;
      const claim = `Live browser retract probe ${index}`;
      const publishedAtMs = Date.now();
      const waitPublished = await prepareBrowserEvent(page, {
        name: "impromptu:card-event",
        revision: publishedRevision,
        status: "PUBLISHED",
      });
      const waitVisible = index === 0 ? await prepareTextMutation(page, claim, true) : null;
      const publishResponse = await fetch(`${projectionOrigin}/internal/cards`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceToken}`,
          connection: "close",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          presentationSessionId,
          event: {
            projectionId,
            status: "PUBLISHED",
            mode: "LIVE",
            leaseExpiresAtMs: publishedAtMs + 3_000,
            publicationPolicyVersion: "publication-policy-1",
            cardVersion: `card-version-browser-${index}`,
            liveBinding: {
              presentationSessionEpoch: "pse_1",
              displayBindingEpoch: "dbe_1",
              publicSlideOccurrence: { publicSlideKey, occurrenceSeq: 1 },
              publicationPolicyVersion: "publication-policy-1",
              cardVersion: `card-version-browser-${index}`,
            },
            claim,
            supportSummary: "Real service and Chrome retract measurement",
            sourceLabel: "Public source",
            publishedAtMs,
            expiresAtMs: publishedAtMs + 3_000,
            publicCardRevision: publishedRevision,
            deckVersion,
            manifestHash,
            occurrence: { publicSlideKey, occurrenceSeq: 1 },
          },
        }),
      });
      if (!publishResponse.ok) throw new Error("live publication probe failed");
      await waitPublished();
      await waitVisible?.();
      cardEvents.push(`${publishedRevision}:PUBLISHED`);

      const waitTombstone = await prepareBrowserEvent(page, {
        name: "impromptu:card-event",
        revision: tombstoneRevision,
        status: "RETRACTED",
      });
      const waitHidden = index === 0 ? await prepareTextMutation(page, claim, false) : null;
      const startedAt = performance.now();
      const retractResponse = await fetch(`${projectionOrigin}/internal/cards`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceToken}`,
          connection: "close",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          presentationSessionId,
          event: {
            projectionId,
            status: "RETRACTED",
            publicCardRevision: tombstoneRevision,
            occurredAtMs: Date.now(),
          },
        }),
      });
      if (!retractResponse.ok) throw new Error("live retract probe failed");
      await waitTombstone();
      await waitHidden?.();
      liveRetractLatencies.push(performance.now() - startedAt);
      cardEvents.push(`${tombstoneRevision}:RETRACTED`);
    }

    await stopProcess(privateProcess);
    await stopProcess(projectionProcess);
    projectionProcess = await startProcess(
      ["bun", "run", "services/projection-gateway/src/main.ts"],
      projectionEnvironment,
      "projection-gateway listening",
    );
    processes.push(projectionProcess);
    privateProcess = await startProcess(
      ["bun", "run", "services/private-backend/src/main.ts"],
      privateEnvironment,
      "private-backend listening",
    );
    processes.push(privateProcess);
    const restoredEventChannel = page.waitForResponse(
      (response) => response.url().endsWith("/v1/events") && response.status() === 200,
      { timeout: 5_000 },
    );
    const restoredSnapshot = page.waitForResponse(
      (response) => response.url().endsWith("/v1/snapshot") && response.status() === 200,
      { timeout: 5_000 },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await restoredEventChannel;
    const restoredSnapshotBody = await (await restoredSnapshot).json();
    if (
      !isRecord(restoredSnapshotBody) ||
      !Array.isArray(restoredSnapshotBody.cards) ||
      !Array.isArray(restoredSnapshotBody.tombstones)
    ) {
      throw new Error("restart snapshot invalid");
    }
    if (restoredSnapshotBody.cards.length !== 0) {
      throw new Error("restart snapshot resurrected revoked content");
    }
    const restoredTombstoneStatuses = restoredSnapshotBody.tombstones.map((value) =>
      isRecord(value) && (value.status === "RETRACTED" || value.status === "EXPIRED")
        ? value.status
        : "INVALID",
    );
    if (
      restoredTombstoneStatuses.length !== 40 ||
      !restoredTombstoneStatuses.includes("RETRACTED") ||
      !restoredTombstoneStatuses.includes("EXPIRED") ||
      restoredTombstoneStatuses.includes("INVALID")
    ) {
      throw new Error("restart snapshot omitted persisted tombstones");
    }

    const waitRestartApplied = await prepareBrowserEvent(page, {
      name: "impromptu:playback-applied",
      commandId: "cmd_after_restart",
    });
    const restartCommand = await privateMutation(
      "/v1/playback/slide-set",
      {
        presentationSessionId,
        commandId: "cmd_after_restart",
        publicSlideKey,
        displayBindingEpoch: "dbe_1",
        baseRevision: "cr_1",
      },
      csrfToken,
      cookie,
    );
    const restartApplied = await waitRestartApplied();
    if (!isRecord(restartApplied)) throw new Error("restart receipt invalid");
    acceptedCommandIds.push(requireString(restartCommand, "commandId"));
    appliedCommandIds.push(requireString(restartApplied, "commandId"));

    const oldControllerEvents = await fetch(
      `${privateOrigin}/v1/playback/controller-events?presentationSessionId=${encodeURIComponent(presentationSessionId)}`,
      { headers: { cookie, origin: consoleOrigin } },
    );
    if (!oldControllerEvents.ok || oldControllerEvents.body === null) {
      throw new Error("old controller event channel failed");
    }
    const oldControllerReader = oldControllerEvents.body.getReader();
    const readyFrame = await readStreamChunk(oldControllerReader);
    if (!readyFrame.includes(": ready")) throw new Error("controller channel did not become ready");

    const takeoverSignIn = await fetch(`${privateOrigin}/v1/account-sessions`, {
      method: "POST",
      headers: browserHeaders(),
      body: JSON.stringify({ authorizationCode: "e2e-takeover-code" }),
    });
    const takeoverSignInBody = await jsonRecord(takeoverSignIn);
    const takeoverCookie = takeoverSignIn.headers.get("set-cookie")?.split(";", 1)[0];
    const takeoverCsrf = requireString(takeoverSignInBody, "csrfToken");
    if (!takeoverSignIn.ok || takeoverCookie === undefined) {
      throw new Error("takeover controller sign-in failed");
    }
    const wrongEpochTakeover = await fetch(`${privateOrigin}/v1/playback/lease-takeover`, {
      method: "POST",
      headers: browserHeaders(takeoverCsrf, takeoverCookie),
      body: JSON.stringify({
        presentationSessionId,
        expectedDisplayBindingEpoch: "dbe_0",
      }),
    });
    if (wrongEpochTakeover.status !== 409) throw new Error("wrong binding epoch was accepted");

    const waitOldControllerClose = readStreamChunk(oldControllerReader);
    const takeover = await privateMutation(
      "/v1/playback/lease-takeover",
      { presentationSessionId, expectedDisplayBindingEpoch: "dbe_1" },
      takeoverCsrf,
      takeoverCookie,
    );
    const closeFrame = await waitOldControllerClose;
    if (!closeFrame.includes('"reason":"SUPERSEDED"')) {
      throw new Error("old controller channel did not close as superseded");
    }
    if (!isRecord(takeover.lease) || takeover.lease.controllerEpoch !== "ce_2") {
      throw new Error("takeover did not advance the controller epoch");
    }
    const oldControllerCommand = await fetch(`${privateOrigin}/v1/playback/slide-set`, {
      method: "POST",
      headers: browserHeaders(csrfToken, cookie),
      body: JSON.stringify({
        presentationSessionId,
        commandId: "cmd_rejected_old_controller",
        publicSlideKey,
        displayBindingEpoch: "dbe_1",
        baseRevision: "cr_2",
      }),
    });
    if (oldControllerCommand.status !== 409) throw new Error("old controller retained authority");

    const waitTakeoverApplied = await prepareBrowserEvent(page, {
      name: "impromptu:playback-applied",
      commandId: "cmd_after_takeover",
    });
    const takeoverCommand = await privateMutation(
      "/v1/playback/slide-set",
      {
        presentationSessionId,
        commandId: "cmd_after_takeover",
        publicSlideKey,
        displayBindingEpoch: "dbe_1",
        baseRevision: "cr_2",
      },
      takeoverCsrf,
      takeoverCookie,
    );
    const takeoverApplied = await waitTakeoverApplied();
    if (!isRecord(takeoverApplied)) throw new Error("takeover receipt invalid");
    acceptedCommandIds.push(requireString(takeoverCommand, "commandId"));
    appliedCommandIds.push(requireString(takeoverApplied, "commandId"));

    const reconnectSnapshot = page.waitForResponse(
      (response) => response.url().endsWith("/v1/snapshot") && response.status() === 200,
      { timeout: 5_000 },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    const snapshotBody = await (await reconnectSnapshot).json();
    if (
      !isRecord(snapshotBody) ||
      !Array.isArray(snapshotBody.cards) ||
      !Array.isArray(snapshotBody.tombstones)
    ) {
      throw new Error("reconnect snapshot invalid");
    }
    trace("reconnect-ready");
    const browserStorageEntries = await page.evaluate(
      () => window.localStorage.length + window.sessionStorage.length,
    );
    const p95 = percentile95(tombstoneLatencies);
    return {
      milestones: [
        "upload",
        "deck-artifacts",
        "authenticated-controller",
        "presentation-session",
        "display-join",
        "display-bound",
        "network-channel-subscribed",
        "slide-set-accepted",
        "stage-applied",
        "candidate-approved",
        "published-card-visible",
        "ordered-retract-tombstone",
        "ordered-expiry-tombstone",
        "live-publication-chrome-retract-measured",
        "both-mains-restarted",
        "restart-tombstones-restored",
        "restart-prefix-applied",
        "controller-takeover",
        "old-controller-superseded",
        "takeover-prefix-applied",
        "reconnect-snapshot",
      ],
      acceptedCommandIds,
      appliedCommandIds,
      cardEvents,
      connectedTombstoneLatencyMs: tombstoneLatencies[0] ?? p95,
      reconnectActiveCardCount: snapshotBody.cards.length,
      reconnectTombstoneStatuses: restoredTombstoneStatuses,
      browserStorageEntries,
      tombstoneP95Ms: p95,
      latencySamples: tombstoneLatencies.length,
      livePublicationRetractP95Ms: percentile95(liveRetractLatencies),
      livePublicationRetractSamples: liveRetractLatencies.length,
      publicCorrelationMatches,
    };
  } finally {
    trace("cleanup-start");
    await context?.close();
    const activeBrowser = browser;
    if (activeBrowser?.isConnected()) {
      const disconnected = new Promise<void>((resolve, reject) => {
        const signal = AbortSignal.timeout(5_000);
        activeBrowser.once("disconnected", () => resolve());
        signal.addEventListener("abort", () => reject(new Error("Chrome close timeout")), {
          once: true,
        });
      });
      const session = await activeBrowser.newBrowserCDPSession();
      await session.send("Browser.close");
      await disconnected;
    } else if (
      chromeProcess !== null &&
      chromeProcess.exitCode === null &&
      chromeProcess.signalCode === null
    ) {
      chromeProcess.kill();
    }
    if (chromeProcess !== null && chromeExited !== null) {
      if (chromeProcess.exitCode === null && chromeProcess.signalCode === null) {
        const timeout = AbortSignal.timeout(5_000);
        await Promise.race([
          chromeExited,
          new Promise<never>((_resolve, reject) => {
            timeout.addEventListener(
              "abort",
              () => reject(new Error("Chrome process exit timeout")),
              { once: true },
            );
          }),
        ]);
      } else {
        await chromeExited;
      }
    }
    for (const process of processes.toReversed()) await stopProcess(process);
    rmSync(profilePath, { force: true, recursive: true });
    rmSync(privateSnapshotPath, { force: true });
    rmSync(projectionDatabasePath, { force: true });
  }
}

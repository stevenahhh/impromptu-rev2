import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright-core";

type Verdict = "PASS" | "FAIL";
type Scenario = Readonly<{
  name: string;
  command: string;
  exitCode: number;
  verdict: Verdict;
  assertions: readonly string[];
  detail?: string;
  /** Wall-clock duration of every completed positive step, in declaration order. */
  stepLatencyMs?: Readonly<Record<string, number>>;
  /** Machine-readable observations captured at the exact point a positive step stopped. */
  diagnostics?: Readonly<Record<string, unknown>>;
}>;

type Upload = Readonly<{
  presentationSessionId: string;
  presentationSessionEpoch: string;
  deckVersion: string;
  manifestHash: string;
}>;

const consoleOrigin = process.env.FIVE_FEATURES_CONSOLE_ORIGIN ?? "http://localhost:4173";
const outputPath = resolve(
  process.env.FIVE_FEATURES_RESULT_PATH ?? ".omo/evidence/task-25/core5-e2e.json",
);
const fixtureRoot = resolve("tests/fixtures/format-neutral-decks");
const timeoutMs = 90_000;

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${name} is not an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${name} is not a non-empty string`);
  return value;
}

async function signIn(page: Page): Promise<string> {
  await page.goto(`${consoleOrigin}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-sign-in-username]").fill("localdemo");
  await page.locator("[data-sign-in-password]").fill("demo-2026-password");
  const response = page.waitForResponse(
    (candidate) => candidate.url().endsWith("/v1/account-sessions") && candidate.status() === 201,
    { timeout: timeoutMs },
  );
  await page.locator("[data-sign-in-submit]").click();
  const body = record(await (await response).json(), "sign-in response");
  await page.locator("[data-deck-file-input]").waitFor({ timeout: timeoutMs });
  return string(body.csrfToken, "csrfToken");
}

async function upload(page: Page, fixture: string): Promise<Upload> {
  await page.locator("[data-deck-file-input]").setInputFiles(resolve(fixtureRoot, fixture));
  const response = page.waitForResponse(
    (candidate) => candidate.url().endsWith("/v1/deck-uploads"),
    { timeout: timeoutMs },
  );
  await page.locator("[data-deck-upload-submit]").click();
  const completed = await response;
  const body = record(await completed.json(), `${fixture} upload response`);
  if (completed.status() !== 201)
    fail(`${fixture} upload returned ${completed.status()}: ${JSON.stringify(body)}`);
  await page.locator("[data-new-deck]").waitFor({ timeout: timeoutMs });
  return {
    presentationSessionId: string(body.presentationSessionId, "presentationSessionId"),
    presentationSessionEpoch: string(body.presentationSessionEpoch, "presentationSessionEpoch"),
    deckVersion: string(body.deckVersion, "deckVersion"),
    manifestHash: string(record(body.privateDeck, "privateDeck").manifestHash, "manifestHash"),
  };
}

/** Installs the exact SSE observer before the Console triggers capture. */
async function subscribeAudio(page: Page, expected: string): Promise<unknown> {
  return await page.evaluate(
    ({ expectedKind, timeout }) =>
      new Promise((resolveEvent, rejectEvent) => {
        const timer = window.setTimeout(
          () => rejectEvent(new Error(`SSE ${expectedKind} timed out`)),
          timeout,
        );
        const listener = (event: Event) => {
          const custom = event as CustomEvent<unknown>;
          const envelope = custom.detail as Record<string, unknown> | null;
          if (envelope?.kind !== expectedKind) return;
          window.clearTimeout(timer);
          window.removeEventListener("five-features:audio", listener);
          resolveEvent(custom.detail);
        };
        window.addEventListener("five-features:audio", listener);
      }),
    { expectedKind: expected, timeout: timeoutMs },
  );
}

async function stopAudio(page: Page, csrfToken: string): Promise<void> {
  const result = await page.evaluate(
    async ({ csrf }) => {
      const response = await fetch("/v1/audio/stream/stop", {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": csrf },
      });
      return { status: response.status, body: await response.text() };
    },
    { csrf: csrfToken },
  );
  if (result.status !== 202) fail(`audio stop returned ${result.status}: ${result.body}`);
}

async function captureFinal(page: Page, csrfToken: string): Promise<Record<string, unknown>> {
  const finalEvent = subscribeAudio(page, "TRANSCRIPT");
  try {
    const frame = page.waitForRequest(
      (request) => request.url().endsWith("/v1/audio/frames") && request.method() === "POST",
      { timeout: timeoutMs },
    );
    await page.locator(".console-consent-notice").locator("..").getByRole("checkbox").check();
    await page.getByRole("button", { name: "Start microphone" }).click();
    await frame;
    // The listener is already installed; stopping is the trigger that flushes a FINAL.
    await stopAudio(page, csrfToken);
    const event = record(await finalEvent, "audio transcript event");
    const transcript = record(event.event, "STT event");
    if (transcript.kind === "FINAL") return event;
    // PARTIAL is observed before FINAL. Subscribe to the next exact named event before it is emitted.
    const final = record(await subscribeAudio(page, "TRANSCRIPT"), "audio FINAL event");
    const finalPayload = record(final.event, "FINAL payload");
    if (finalPayload.kind !== "FINAL") {
      fail(`expected FINAL after stream stop, received ${String(finalPayload.kind)}`);
    }
    return final;
  } catch (error) {
    await finalEvent.catch(() => undefined);
    throw error;
  }
}

async function recommendation(
  page: Page,
  csrfToken: string,
  uploadReceipt: Upload,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await page.evaluate(
    async ({ csrf, deckVersion, manifestHash }) => {
      const response = await fetch("/v1/recommendations", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({
          query: "형식 중립 근거 자료 2026",
          deckVersion,
          manifestHash,
          maxResults: 3,
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    {
      csrf: csrfToken,
      deckVersion: uploadReceipt.deckVersion,
      manifestHash: uploadReceipt.manifestHash,
    },
  );
  return {
    status: response.status,
    body: record(response.body, "recommendation response"),
  };
}

/** Counts only machine values; transcript text itself is never recorded. */
function transcriptMetrics(final: Record<string, unknown>): Record<string, unknown> {
  const payload = record(final.event, "FINAL payload");
  const transcript = record(payload.transcript, "FINAL transcript");
  const words = Array.isArray(transcript.words) ? transcript.words.length : null;
  return {
    finalKind: payload.kind,
    finalSequence: payload.sequence,
    transcriptCharacters: typeof transcript.text === "string" ? transcript.text.length : null,
    transcriptWordCount: words,
    transcriptDurationMs: transcript.durationMs ?? null,
  };
}

async function runPositive(context: BrowserContext, fixture: string): Promise<Scenario> {
  const page = await context.newPage();
  const assertions = [
    "upload-201",
    "fake-device-webm-final",
    "hybrid-rrf-recommend",
    "opt-in-coaching",
  ] as const;
  const command = "Console upload + fake-device WebM capture + private HTTP recommendation";
  const stepLatencyMs: Record<string, number> = {};
  const diagnostics: Record<string, unknown> = {};
  let step = "sign-in";
  async function measure<T>(name: string, work: () => Promise<T>): Promise<T> {
    step = name;
    const startedAtMs = Date.now();
    try {
      return await work();
    } finally {
      stepLatencyMs[name] = Date.now() - startedAtMs;
    }
  }
  try {
    const csrfToken = await measure("sign-in", async () => await signIn(page));
    const receipt = await measure("upload", async () => await upload(page, fixture));
    diagnostics.presentationSessionId = receipt.presentationSessionId;
    diagnostics.deckVersion = receipt.deckVersion;
    const final = await measure("capture-final", async () => await captureFinal(page, csrfToken));
    Object.assign(diagnostics, transcriptMetrics(final));
    if (diagnostics.finalKind !== "FINAL") fail("whisper did not emit FINAL");
    const result = await measure(
      "recommendation",
      async () => await recommendation(page, csrfToken, receipt),
    );
    diagnostics.recommendationStatus = result.status;
    diagnostics.recommendationOutcome = result.body.outcome ?? null;
    diagnostics.recommendationReason = result.body.reason ?? null;
    diagnostics.recommendationLatencyMs = result.body.latencyMs ?? null;
    diagnostics.recommendationEvidenceCount = Array.isArray(result.body.evidence)
      ? result.body.evidence.length
      : 0;
    diagnostics.recommendationResponseBody = result.body;
    if (result.status !== 200) fail(`recommendation returned ${result.status}`);
    const outcome = string(result.body.outcome, "recommendation outcome");
    if (outcome !== "RECOMMEND")
      fail(`hybrid retrieval did not recommend: ${JSON.stringify(result.body)}`);
    await measure("opt-in-coaching", async () => {
      const coaching = page.locator('[data-coaching-state="active"]');
      await page.getByRole("checkbox", { name: /coaching/i }).check();
      const rendered = await coaching.count();
      diagnostics.coachingActiveNodes = rendered;
      if (rendered !== 1) fail("opt-in coaching did not render active state");
    });
    return {
      name: `positive-${fixture}`,
      command,
      exitCode: 0,
      verdict: "PASS",
      assertions: [...assertions],
      stepLatencyMs,
      diagnostics,
    };
  } catch (error) {
    return {
      name: `positive-${fixture}`,
      command,
      exitCode: 1,
      verdict: "FAIL",
      assertions: [...assertions],
      detail: error instanceof Error ? error.message : String(error),
      stepLatencyMs,
      diagnostics: { failedStep: step, ...diagnostics },
    };
  } finally {
    await page.close();
  }
}

async function commandScenario(
  name: string,
  assertion: string,
  command: readonly string[],
): Promise<Scenario> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await child.exited;
  const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
  return {
    name,
    command: command.join(" "),
    exitCode,
    verdict: exitCode === 0 ? "PASS" : "FAIL",
    assertions: [assertion],
    ...(exitCode === 0 ? {} : { detail: output.slice(-2_000) }),
  };
}

async function micDenied(context: BrowserContext): Promise<Scenario> {
  const page = await context.newPage();
  let audioRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/v1/audio/")) audioRequests += 1;
  });
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          throw new DOMException("denied", "NotAllowedError");
        },
      });
    });
    await signIn(page);
    await upload(page, "korean-text-layer.pdf");
    await page
      .getByRole("checkbox", { name: "I consent to microphone capture for the stated purpose." })
      .check();
    await page.getByRole("button", { name: "Start microphone" }).click();
    await page.getByText("MICROPHONE_DENIED").waitFor({ timeout: timeoutMs });
    if (audioRequests !== 0) fail(`microphone denial made ${audioRequests} audio requests`);
    return {
      name: "negative-mic-denied-audio-request-zero",
      command: "Console denied getUserMedia + request observer",
      exitCode: 0,
      verdict: "PASS",
      assertions: ["audio-request-count=0"],
    };
  } catch (error) {
    return {
      name: "negative-mic-denied-audio-request-zero",
      command: "Console denied getUserMedia + request observer",
      exitCode: 1,
      verdict: "FAIL",
      assertions: ["audio-request-count=0"],
      detail: String(error),
    };
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      ...(process.env.FIVE_FEATURES_AUDIO_WAV === undefined
        ? []
        : [`--use-file-for-fake-audio-capture=${process.env.FIVE_FEATURES_AUDIO_WAV}`]),
    ],
  });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const Native = window.EventSource;
    class ObservedEventSource extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        for (const type of ["READY", "TRANSCRIPT", "RECOMMENDATION", "TERMINAL"]) {
          this.addEventListener(type, (event) => {
            const source = event as MessageEvent<string>;
            try {
              window.dispatchEvent(
                new CustomEvent("five-features:audio", { detail: JSON.parse(source.data) }),
              );
            } catch {
              // Invalid server data is intentionally not treated as a valid signal.
            }
          });
        }
      }
    }
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: ObservedEventSource,
    });
  });
  const scenarios: Scenario[] = [];
  try {
    scenarios.push(await runPositive(context, "korean-text-layer.pdf"));
    scenarios.push(await runPositive(context, "korean-structural.pptx"));
    scenarios.push(await micDenied(context));
    scenarios.push(
      await commandScenario(
        "negative-external-429-internal-only",
        "HTTP_429 retains internal RECOMMEND",
        ["bun", "test", "services/private-backend/test/recommendation-pipeline.test.ts"],
      ),
      await commandScenario("negative-stage-snapshot-cards-zero", "snapshot cards=0", [
        "bun",
        "test",
        "tests/security/release-security.test.ts",
      ]),
      await commandScenario("negative-stage-sse-cards-zero", "SSE CARD dropped", [
        "bun",
        "test",
        "services/projection-gateway/test/prepared-evidence.test.ts",
      ]),
      await commandScenario("negative-stage-ws-cards-zero", "WS CARD dropped", [
        "bun",
        "test",
        "apps/stage/src/stage-client.test.ts",
      ]),
      await commandScenario(
        "negative-aba-reload-dwell-identical",
        "A-B-A report dwell byte-equivalent after reload",
        ["bun", "test", "services/private-backend/test/session-report-finalizer.test.ts"],
      ),
      await commandScenario("stt-partial-before-final", "PARTIAL precedes exactly-one FINAL", [
        "bun",
        "test",
        "services/private-backend/test/stt-whisper-cpp.test.ts",
      ]),
      await commandScenario(
        "stt-revoke-stops-and-blocks-late-delivery",
        "revoke terminal blocks late delivery",
        ["bun", "test", "services/private-backend/test/audio-ingest-http.test.ts"],
      ),
    );
  } finally {
    await context.close();
    await browser.close();
  }
  const result = {
    command: "python3 scripts/verify-five-private-presentation-features.py",
    exitCode: scenarios.every((scenario) => scenario.verdict === "PASS") ? 0 : 1,
    scenarios,
    positive: `${scenarios.filter((item) => item.name.startsWith("positive-") && item.verdict === "PASS").length}/2`,
    negative: `${scenarios.filter((item) => item.name.startsWith("negative-") && item.verdict === "PASS").length}/6`,
    stt: `${scenarios.filter((item) => item.name.startsWith("stt-") && item.verdict === "PASS").length}/2`,
  };
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  if (result.exitCode !== 0) process.exitCode = 1;
}

void main();

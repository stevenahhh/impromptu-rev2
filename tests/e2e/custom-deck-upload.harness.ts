import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

interface JsonRecord {
  [key: string]: unknown;
}
type ServiceProcess = ChildProcessByStdio<null, Readable, Readable>;

interface ElementStyleEvidence {
  readonly opacity: string;
  readonly visibility: string;
  readonly fill: string;
  readonly paintedFill: string | null;
}

export interface CustomDeckUploadEvidence {
  readonly environment: {
    readonly consoleOrigin: string;
    readonly sofficePath: string;
    readonly libreOfficeVersion: string;
    readonly fontPath: string;
    readonly fontVersion: string;
    readonly fontSha256: string;
    readonly fixtureSha256: { readonly pptx: string; readonly pdf: string };
  };
  readonly httpResponses: {
    readonly signIn201: JsonRecord;
    readonly pptxUpload201: JsonRecord;
    readonly pdfUpload201: JsonRecord;
  };
  readonly signIn201: {
    readonly status: number;
    readonly account: JsonRecord;
  };
  readonly pptxUpload201: {
    readonly status: number;
    readonly presentationSessionId: string;
    readonly deckVersion: string;
  };
  readonly pdfUpload201: {
    readonly status: number;
    readonly presentationSessionId: string;
    readonly deckVersion: string;
  };
  readonly presentationReady: readonly string[];
  readonly pptx: {
    readonly slideCount: number;
    readonly dimensions: { readonly width: number; readonly height: number };
    readonly stageBoundingBox: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly svgViewBox: { readonly width: number; readonly height: number };
    readonly renderedLabels: readonly string[];
    readonly effectClasses: readonly string[];
    readonly clickGroups: number;
    readonly transition: string;
    readonly transitionComplete: boolean;
    readonly computedOpacity: number;
    readonly font: {
      readonly family: string;
      readonly httpStatus: number;
      readonly readiness: string;
      readonly faceStatus: string;
      readonly check: boolean;
      readonly computedFamily: string;
      readonly byteSize: number;
      readonly sha256: string;
    };
    readonly clickGroupEvidence: readonly {
      readonly before: number;
      readonly after: number;
      readonly targetId: string;
      readonly effectClass: string;
      readonly beforeStyle: ElementStyleEvidence;
      readonly afterStyle: ElementStyleEvidence;
      readonly screenshot: string;
    }[];
    readonly runtimeGroupsAdvanced: number;
  };
  readonly pdf: {
    readonly pageCount: number;
    readonly dimensions: readonly { readonly width: number; readonly height: number }[];
    readonly staticRuntimeCount: number;
    readonly computedOpacity: number;
    readonly firstPageVisible: boolean;
    readonly secondPageVisible: boolean;
    readonly navigation: {
      readonly fromPublicSlideKey: string;
      readonly toPublicSlideKey: string;
    };
  };
  readonly screenshots: readonly string[];
  readonly actions: readonly string[];
  readonly cleanup: readonly string[];
}

const fixtureRoot = resolve("tests/fixtures/custom-deck-upload");
const evidenceRoot = resolve("artifacts/custom-deck-upload-e2e");
const defaultSofficePath = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
const defaultFontPath = resolve(process.env.HOME ?? "", "Library/Fonts/DejaVuSans.ttf");
const controllerUsername = "customdeck";
const controllerPassword = "custom-deck-password";
const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} was not a JSON object`);
  }
  return value as JsonRecord;
}

function stringField(value: JsonRecord, field: string): string {
  const result = value[field];
  if (typeof result !== "string") throw new Error(`${field} was not a string`);
  return result;
}

function objectField(value: JsonRecord, field: string): JsonRecord {
  return record(value[field], field);
}

function arrayField(value: JsonRecord, field: string): unknown[] {
  const result = value[field];
  if (!Array.isArray(result)) throw new Error(`${field} was not an array`);
  return result;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function redacted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redacted);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      /(?:authorization|cookie|csrf|secret|token)/i.test(key) ? "[REDACTED]" : redacted(field),
    ]),
  );
}

function commandVersion(executable: string): string {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${executable} --version failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("ephemeral port missing");
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

async function preferredPort(port: number): Promise<number> {
  const server = createNetServer();
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolveListen);
    });
    return port;
  } catch {
    return availablePort();
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }
}

async function waitForOutput(
  stream: Readable,
  expected: string,
  timeoutMs = 15_000,
): Promise<void> {
  await new Promise<void>((resolveWait, reject) => {
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
        resolveWait();
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`process exited before ${expected}: ${output}`));
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
  expected: string,
  cwd = resolve("."),
): Promise<ServiceProcess> {
  const executable = command[0];
  if (executable === undefined) throw new Error("empty process command");
  const child = spawn(executable, command.slice(1), {
    cwd,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForOutput(child.stdout, expected);
    return child;
  } catch (error) {
    const stderr = await new Promise<string>((resolveError) => {
      let output = "";
      child.stderr.on("data", (chunk) => {
        output += chunk.toString("utf8");
      });
      child.once("exit", () => resolveError(output));
      child.kill();
    });
    throw new Error(`${String(error)}\n${stderr}`);
  }
}

async function stopProcess(child: ServiceProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.kill("SIGTERM");
  await exited;
}

async function streamText(stream: Readable): Promise<string> {
  let output = "";
  for await (const chunk of stream) output += chunk.toString("utf8");
  return output;
}

async function runCommand(
  command: readonly string[],
  environment: Record<string, string> = {},
  cwd = resolve("."),
): Promise<void> {
  const executable = command[0];
  if (executable === undefined) throw new Error("empty command");
  const child = spawn(executable, command.slice(1), {
    cwd,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [code, stdout, stderr] = await Promise.all([
    once(child, "exit", { signal: AbortSignal.timeout(90_000) }).then(([value]) => value),
    streamText(child.stdout),
    streamText(child.stderr),
  ]);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} failed (${String(code)}):\n${stdout}\n${stderr}`);
  }
}

function startBrowserOrigin(options: {
  readonly port: number;
  readonly distributionRoot: string;
  readonly proxyOrigin: string;
  readonly publicAssetOrigin: string;
}) {
  const root = resolve(options.distributionRoot);
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/internal/")) {
        return fetch(`${options.proxyOrigin}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: "manual",
        });
      }
      const requested = url.pathname === "/" ? "/index.html" : url.pathname;
      let candidatePath = resolve(root, `.${requested}`);
      if (!candidatePath.startsWith(`${root}/`)) candidatePath = join(root, "index.html");
      let file = Bun.file(candidatePath);
      if (!(await file.exists())) file = Bun.file(join(root, "index.html"));
      const extension = extname(file.name ?? "") || ".html";
      return new Response(file, {
        headers: {
          "content-type": contentTypes[extension] ?? "application/octet-stream",
          "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' ${options.publicAssetOrigin} data:; connect-src 'self' ${options.publicAssetOrigin}; font-src 'self' ${options.publicAssetOrigin}; worker-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
        },
      });
    },
  });
}

async function privateMutation(
  privateOrigin: string,
  consoleOrigin: string,
  path: string,
  body: unknown,
  csrfToken: string,
  cookie: string,
  expectedStatus: number,
): Promise<JsonRecord> {
  const response = await fetch(`${privateOrigin}${path}`, {
    method: "POST",
    headers: {
      origin: consoleOrigin,
      referer: `${consoleOrigin}/`,
      cookie,
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify(body),
  });
  const result = record(await response.json(), path);
  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status}: ${JSON.stringify(result)}`);
  }
  return result;
}

interface StageRun {
  readonly page: Page;
  readonly firstSlide: JsonRecord;
}

interface UploadRun {
  readonly status: number;
  readonly body: JsonRecord;
}

function evidencePath(name: string): string {
  return `artifacts/custom-deck-upload-e2e/${name}`;
}

async function captureScreenshot(page: Page, name: string, screenshots: string[]): Promise<string> {
  await page.screenshot({ path: join(evidenceRoot, name), fullPage: true });
  const path = evidencePath(name);
  screenshots.push(path);
  return path;
}

async function waitForAttribute(
  page: Page,
  selector: string,
  attribute: string,
  expected: string,
): Promise<void> {
  try {
    await page.waitForFunction(
      ({ selector: query, attribute: name, expected: value }) =>
        document.querySelector(query)?.getAttribute(name) === value,
      { selector, attribute, expected },
    );
  } catch (error) {
    const observed = await page
      .locator(selector)
      .first()
      .evaluate((element) => ({
        attributes: Object.fromEntries(
          [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
        ),
        html: element.outerHTML.slice(0, 2_000),
      }));
    throw new Error(
      `Timed out waiting for ${selector} ${attribute}=${expected}: ${JSON.stringify(observed)}`,
      { cause: error },
    );
  }
}

async function waitForStageReveal(page: Page): Promise<void> {
  await page.locator('[data-stage-slide-surface="uploaded"]').evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
}

async function openStage(options: {
  readonly context: BrowserContext;
  readonly stageOrigin: string;
  readonly privateOrigin: string;
  readonly consoleOrigin: string;
  readonly upload: JsonRecord;
  readonly csrfToken: string;
  readonly cookie: string;
  readonly actions: string[];
}): Promise<StageRun> {
  const publicDeck = objectField(options.upload, "publicDeck");
  const slides = arrayField(publicDeck, "slides").map((slide) => record(slide, "slide"));
  const firstSlide = slides[0];
  if (firstSlide === undefined) throw new Error("uploaded deck has no first slide");
  const page = await options.context.newPage();
  if (process.env.DEBUG_CUSTOM_DECK_E2E === "true") {
    page.on("console", (message) => console.log(`[stage:${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => console.log(`[stage:error] ${error.message}`));
    page.on("response", (response) =>
      console.log(`[stage:response] ${response.status()} ${response.url()}`),
    );
    page.on("requestfailed", (request) =>
      console.log(`[stage:failed] ${request.url()} ${request.failure()?.errorText ?? "unknown"}`),
    );
  }
  const joinResponse = page.waitForResponse(
    (response) => response.url().endsWith("/v1/display-joins") && response.status() === 201,
  );
  await page.goto(
    `${options.stageOrigin}/?deck=${encodeURIComponent(stringField(options.upload, "deckVersion"))}`,
    { waitUntil: "domcontentloaded" },
  );
  await joinResponse;
  const join = record(
    await page.evaluate(async () => {
      const buffered = Reflect.get(window, "__customDeckStageJoins") as unknown[];
      if (buffered[0] !== undefined) return buffered[0];
      return await new Promise<unknown>((resolveJoin, reject) => {
        const signal = AbortSignal.timeout(5_000);
        signal.addEventListener(
          "abort",
          () => reject(new Error("Stage did not publish its active display join")),
          { once: true },
        );
        window.addEventListener(
          "impromptu:display-join",
          (event) => resolveJoin(event instanceof CustomEvent ? event.detail : null),
          { once: true },
        );
      });
    }),
    "display join",
  );
  options.actions.push(
    `Stage created display join for ${stringField(options.upload, "deckVersion")}`,
  );
  await privateMutation(
    options.privateOrigin,
    options.consoleOrigin,
    "/v1/display-bindings",
    {
      presentationSessionId: stringField(options.upload, "presentationSessionId"),
      displayJoinId: stringField(join, "displayJoinId"),
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: stringField(options.upload, "deckVersion"),
      approvedDisplayId: stringField(join, "displayId"),
      approvedDisplayFingerprint: stringField(join, "displayFingerprint"),
    },
    options.csrfToken,
    options.cookie,
    201,
  );
  options.actions.push("Controller approved display binding");
  const snapshotResponse = page.waitForResponse(
    (response) => response.url().includes("/v1/snapshot") && response.status() === 200,
  );
  await page.locator("[data-display-claim]").click();
  await snapshotResponse;
  const appliedResponse = page.waitForResponse(
    (response) => response.url().endsWith("/v1/stage-applied") && response.status() === 200,
  );
  await privateMutation(
    options.privateOrigin,
    options.consoleOrigin,
    "/v1/playback/slide-set",
    {
      presentationSessionId: stringField(options.upload, "presentationSessionId"),
      commandId: `cmd_custom_${slides.length}_${stringField(options.upload, "deckVersion").slice(-8)}`,
      publicSlideKey: stringField(firstSlide, "publicSlideKey"),
      displayBindingEpoch: "dbe_1",
      baseRevision: "cr_0",
    },
    options.csrfToken,
    options.cookie,
    202,
  );
  await appliedResponse;
  await waitForStageReveal(page);
  options.actions.push("Stage acknowledged first-slide playback");
  return { page, firstSlide };
}

async function uploadFromConsole(
  page: Page,
  fixture: string,
  actions: string[],
): Promise<UploadRun> {
  const input = page.locator("[data-deck-file-input]");
  if ((await input.count()) === 0) {
    await page.locator("[data-new-deck]").click();
  }
  await input.setInputFiles(join(fixtureRoot, fixture));
  actions.push(`Console selected ${fixture}`);
  const responseIndex = await page.evaluate(
    () => (Reflect.get(window, "__customDeckUploadResponses") as unknown[]).length,
  );
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/v1/deck-uploads"),
    { timeout: 60_000 },
  );
  await page.locator("[data-deck-upload-submit]").click();
  const response = await responsePromise;
  await response.finished();
  if (response.status() !== 201) {
    await page.locator(".console-caption--error").waitFor();
    const failed = await page.evaluate(
      (index) =>
        (
          Reflect.get(window, "__customDeckUploadResponses") as Array<{
            status: number;
            body: string;
          }>
        )[index],
      responseIndex,
    );
    const blocker = `${fixture} upload returned ${response.status()}: ${failed?.body ?? "body unavailable"}`;
    await Bun.write(
      join(evidenceRoot, "red-blocker.json"),
      `${JSON.stringify({ blocker, fixture, status: response.status(), actions }, null, 2)}\n`,
    );
    throw new Error(blocker);
  }
  await page.locator("[data-new-deck]").waitFor();
  const captured = await page.evaluate(
    (index) =>
      (
        Reflect.get(window, "__customDeckUploadResponses") as Array<{
          status: number;
          body: string;
        }>
      )[index],
    responseIndex,
  );
  if (captured?.status !== 201) throw new Error(`${fixture} raw 201 body was not captured`);
  const body = record(JSON.parse(captured.body), `${fixture} upload`);
  actions.push(
    `Console displayed Presentation ready for ${stringField(body, "presentationSessionId")}`,
  );
  return { status: response.status(), body };
}

export async function runCustomDeckUploadE2e(): Promise<CustomDeckUploadEvidence> {
  rmSync(evidenceRoot, { recursive: true, force: true });
  mkdirSync(evidenceRoot, { recursive: true });
  const runtimeRoot = mkdtempSync(join(tmpdir(), "impromptu-custom-deck-e2e-"));
  const stagingRoot = join(runtimeRoot, "staging");
  const artifactRoot = join(runtimeRoot, "assets");
  mkdirSync(stagingRoot);
  mkdirSync(artifactRoot);

  const [privatePort, projectionPort, consolePort, stagePort] = await Promise.all([
    availablePort(),
    availablePort(),
    preferredPort(4173),
    availablePort(),
  ]);
  const privateOrigin = `http://127.0.0.1:${privatePort}`;
  const projectionOrigin = `http://127.0.0.1:${projectionPort}`;
  // Chromium accepts Secure __Host cookies on the localhost secure-context exception,
  // while rejecting them on plain 127.0.0.1.
  const consoleOrigin = `http://localhost:${consolePort}`;
  const stageOrigin = `http://127.0.0.1:${stagePort}`;
  const sofficePath = process.env.SOFFICE_PATH ?? defaultSofficePath;
  const fontPath = process.env.IMPROMPTU_E2E_FONT_PATH ?? defaultFontPath;
  const libreOfficeVersion = commandVersion(sofficePath);
  const fontVersion = "DejaVu 2.37 (Homebrew font-dejavu cask)";
  const fontSha256 = sha256File(fontPath);
  const processes: ServiceProcess[] = [];
  const cleanup: string[] = [];
  const actions: string[] = [];
  const screenshots: string[] = [];
  let browser: Browser | null = null;
  let stageServer: ReturnType<typeof Bun.serve> | null = null;
  let evidence: Omit<CustomDeckUploadEvidence, "cleanup"> | null = null;

  try {
    await runCommand([
      resolve("services/ingestion/.venv/bin/python"),
      resolve("tests/fixtures/custom-deck-upload/generate.py"),
    ]);
    const fixtureSha256 = {
      pptx: sha256File(join(fixtureRoot, "custom-runtime-deck.pptx")),
      pdf: sha256File(join(fixtureRoot, "custom-static-deck.pdf")),
    };
    actions.push(
      `Regenerated deterministic PPTX ${fixtureSha256.pptx} and PDF ${fixtureSha256.pdf}`,
    );
    await Promise.all([
      runCommand(
        ["bun", "run", "build"],
        {
          CONSOLE_PRIVATE_API_ORIGIN: "https://private-backend.e2e.invalid",
          NEXT_PUBLIC_STAGE_ORIGIN: stageOrigin,
        },
        resolve("apps/console"),
      ),
      runCommand(
        ["bun", "run", "build"],
        { STAGE_PUBLIC_API_ORIGIN: stageOrigin },
        resolve("apps/stage"),
      ),
    ]);
    const token = "custom-deck-upload-e2e-token";
    processes.push(
      await startProcess(
        ["bun", "run", "services/projection-gateway/src/main.ts"],
        {
          PROJECTION_GATEWAY_HOST: "127.0.0.1",
          PROJECTION_GATEWAY_PORT: String(projectionPort),
          PROJECTION_GATEWAY_STATE_KEY: join(runtimeRoot, "projection.json"),
          PRIVATE_BACKEND_ORIGIN: privateOrigin,
          SERVICE_AUTH_TOKEN: token,
          STAGE_ORIGIN: stageOrigin,
          DECK_ARTIFACT_ROOT: artifactRoot,
        },
        "projection-gateway listening",
      ),
    );
    processes.push(
      await startProcess(
        ["bun", "run", "services/private-backend/src/main.ts"],
        {
          CONSOLE_ORIGIN: consoleOrigin,
          CONTROLLER_ACCOUNT_ID: "account_custom_deck_e2e",
          CONTROLLER_USERNAME: controllerUsername,
          CONTROLLER_PASSWORD: controllerPassword,
          CHAT_MODEL_API_KEY: "e2e-provider-key",
          EMBEDDING_MODEL_API_KEY: "e2e-provider-key",
          CHAT_MODEL_BASE_URL: "https://models.example.test/v1",
          EMBEDDING_MODEL_BASE_URL: "https://embeddings.example.test/v1",
          EMBEDDING_MODEL: "embedding-test",
          RERANK_MODEL: "rerank-test",
          LLM_MODEL: "llm-test",
          VERIFIER_MODEL: "verifier-test",
          PRIVATE_BACKEND_HOST: "127.0.0.1",
          PRIVATE_BACKEND_PORT: String(privatePort),
          PRIVATE_PREPARED_EVIDENCE_STATE_KEY: join(runtimeRoot, "private.json"),
          // Route projection writes and published assets through the Stage origin so the
          // production Stage CSP exercises the same-origin public asset boundary.
          PROJECTION_GATEWAY_ORIGIN: stageOrigin,
          SERVICE_AUTH_TOKEN: token,
          DECK_STAGING_ROOT: stagingRoot,
          DECK_ARTIFACT_ROOT: artifactRoot,
          SOFFICE_PATH: sofficePath,
        },
        "private-backend listening",
      ),
    );
    processes.push(
      await startProcess(
        ["node", "node_modules/next/dist/bin/next", "start", "--port", String(consolePort)],
        {
          CONSOLE_PRIVATE_API_ORIGIN: privateOrigin,
        },
        "Ready in",
        resolve("apps/console"),
      ),
    );
    stageServer = startBrowserOrigin({
      port: stagePort,
      distributionRoot: "apps/stage/dist",
      proxyOrigin: projectionOrigin,
      publicAssetOrigin: projectionOrigin,
    });
    actions.push(
      `Started real backend/gateway mains and browser origins; Console ${consoleOrigin}; ${libreOfficeVersion}`,
    );

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      const responses: Array<{ status: number; body: string }> = [];
      Reflect.set(window, "__customDeckUploadResponses", responses);
      const stageJoins: unknown[] = [];
      Reflect.set(window, "__customDeckStageJoins", stageJoins);
      window.addEventListener("impromptu:display-join", (event) => {
        stageJoins.push(event instanceof CustomEvent ? event.detail : null);
      });
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function open(method: string, url: string | URL) {
        if (String(url).endsWith("/v1/deck-uploads")) {
          this.addEventListener(
            "load",
            () => responses.push({ status: this.status, body: this.responseText }),
            { once: true },
          );
        }
        return Reflect.apply(originalOpen, this, [method, url]);
      };
    });
    const consolePage = await context.newPage();
    await consolePage.goto(`${consoleOrigin}/sign-in`, { waitUntil: "domcontentloaded" });
    await consolePage.locator("[data-sign-in-username]").fill(controllerUsername);
    await consolePage.locator("[data-sign-in-password]").fill(controllerPassword);
    const signInResponse = consolePage.waitForResponse(
      (response) => response.url().endsWith("/v1/account-sessions") && response.status() === 201,
    );
    await consolePage.locator("[data-sign-in-submit]").click();
    const signInHttpResponse = await signInResponse;
    const signInBody = record(await signInHttpResponse.json(), "sign-in response");
    const csrfToken = stringField(signInBody, "csrfToken");
    const signIn201 = {
      status: signInHttpResponse.status(),
      account: objectField(signInBody, "account"),
    };
    await consolePage.locator("[data-deck-file-input]").waitFor();
    const cookies = await context.cookies(consoleOrigin);
    const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    if (cookie.length === 0) throw new Error("browser sign-in did not retain the account cookie");
    actions.push("Console completed real sign-in with a 201 response");

    const pptxUpload = await uploadFromConsole(consolePage, "custom-runtime-deck.pptx", actions);
    await captureScreenshot(consolePage, "console-pptx-ready.png", screenshots);
    const pptxUpload201 = pptxUpload.body;
    const pptxDeck = objectField(pptxUpload201, "publicDeck");
    const pptxSlides = arrayField(pptxDeck, "slides").map((slide) => record(slide, "pptx slide"));
    const pptxSlide = pptxSlides[0];
    if (pptxSlide === undefined) throw new Error("PPTX receipt had no slide");
    const pptxImage = objectField(pptxSlide, "image");
    const pptxRuntime = objectField(pptxSlide, "runtime");
    const pptxTimeline = objectField(pptxRuntime, "timeline");
    const clickGroups = arrayField(pptxTimeline, "click_groups");
    const effectClasses = clickGroups.map((group) => {
      if (!Array.isArray(group) || group.length !== 1)
        throw new Error("PPTX click group was not singular");
      return stringField(record(group[0], "PPTX effect"), "effect_class");
    });
    const fontReference = arrayField(pptxRuntime, "fonts")[0];
    const embeddedFont =
      typeof fontReference === "string"
        ? { family: "unavailable", url: fontReference }
        : {
            family: stringField(record(fontReference, "PPTX embedded font"), "family"),
            url: stringField(record(fontReference, "PPTX embedded font"), "url"),
          };
    const pptxStage = await openStage({
      context,
      stageOrigin,
      privateOrigin,
      consoleOrigin,
      upload: pptxUpload201,
      csrfToken,
      cookie,
      actions,
    });
    const runtimeSelector = "[data-slide-runtime]";
    const runtimeHost = pptxStage.page.locator(runtimeSelector).first();
    await runtimeHost.waitFor({ state: "attached" });
    await waitForAttribute(pptxStage.page, runtimeSelector, "data-slide-runtime", "active");
    await waitForAttribute(pptxStage.page, runtimeSelector, "data-transition-complete", "true");
    const transitionComplete =
      (await runtimeHost.getAttribute("data-transition-complete")) === "true";
    const computedOpacity = Number(
      await runtimeHost.evaluate((element) => getComputedStyle(element).opacity),
    );
    const fontStatus = await pptxStage.page.evaluate(
      async (url) => (await fetch(url)).status,
      embeddedFont.url,
    );
    const fontEvidence = await pptxStage.page.evaluate(async ({ family, url }) => {
      const response = await fetch(url);
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const independentFace = new FontFace(family, bytes);
      const loadedFace = await independentFace.load();
      document.fonts.add(loadedFace);
      await document.fonts.ready;
      const renderedText = document.querySelector(
        `[data-slide-runtime="active"] svg [font-family*="${family}"]`,
      );
      if (!(renderedText instanceof SVGElement)) {
        throw new Error("rendered SVG did not apply the embedded font family");
      }
      const computedFamily = getComputedStyle(renderedText).fontFamily;
      return {
        readiness: document.fonts.status,
        faceStatus: loadedFace.status,
        check: document.fonts.check(`16px "${family}"`),
        computedFamily,
        byteSize: bytes.byteLength,
        sha256,
      };
    }, embeddedFont);
    const boundingBox = await runtimeHost.boundingBox();
    if (boundingBox === null) throw new Error("active Stage runtime had no bounding box");
    const stageGeometry = await runtimeHost.evaluate((element) => {
      const svg = element.querySelector("svg");
      if (!(svg instanceof SVGSVGElement)) throw new Error("active Stage runtime had no SVG");
      return {
        svgViewBox: { width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height },
        renderedLabels: [...svg.querySelectorAll("text")]
          .map((node) => node.textContent?.trim() ?? "")
          .filter(Boolean),
      };
    });
    const targetStyle = async (targetId: string): Promise<ElementStyleEvidence> =>
      pptxStage.page.evaluate((id) => {
        const target = document.getElementById(id);
        if (target === null) throw new Error(`runtime target ${id} was missing`);
        const style = getComputedStyle(target);
        const painted = [...target.querySelectorAll("[fill]")].find(
          (candidate) => candidate.getAttribute("fill") !== "none",
        );
        return {
          opacity: style.opacity,
          visibility: style.visibility,
          fill: style.fill,
          paintedFill: painted === undefined ? null : getComputedStyle(painted).fill,
        };
      }, targetId);
    await captureScreenshot(pptxStage.page, "stage-pptx-before-click.png", screenshots);
    const clickGroupEvidence: Array<{
      before: number;
      after: number;
      targetId: string;
      effectClass: string;
      beforeStyle: ElementStyleEvidence;
      afterStyle: ElementStyleEvidence;
      screenshot: string;
    }> = [];
    for (let group = 1; group <= clickGroups.length; group += 1) {
      const before = Number(await runtimeHost.getAttribute("data-click-group"));
      const clickGroup = clickGroups[group - 1];
      if (!Array.isArray(clickGroup) || clickGroup.length !== 1) {
        throw new Error(`PPTX click group ${group} was not singular`);
      }
      const effect = record(clickGroup[0], `PPTX click group ${group} effect`);
      const targetId = stringField(objectField(effect, "target"), "svg_element_id");
      const effectClass = stringField(effect, "effect_class");
      const beforeStyle = await targetStyle(targetId);
      const advanced = waitForAttribute(
        pptxStage.page,
        runtimeSelector,
        "data-click-group",
        String(group),
      );
      await pptxStage.page.keyboard.press("ArrowRight");
      await advanced;
      const afterStyle = await targetStyle(targetId);
      const name = `stage-pptx-after-${effectClass}.png`;
      const screenshot = await captureScreenshot(pptxStage.page, name, screenshots);
      clickGroupEvidence.push({
        before,
        after: group,
        targetId,
        effectClass,
        beforeStyle,
        afterStyle,
        screenshot,
      });
      actions.push(`Stage advanced PPTX click group ${before} -> ${group}`);
    }
    const runtimeGroupsAdvanced = Number(await runtimeHost.getAttribute("data-click-group"));
    await pptxStage.page.close();

    const pdfUpload = await uploadFromConsole(consolePage, "custom-static-deck.pdf", actions);
    await captureScreenshot(consolePage, "console-pdf-ready.png", screenshots);
    const pdfUpload201 = pdfUpload.body;
    const pdfDeck = objectField(pdfUpload201, "publicDeck");
    const pdfSlides = arrayField(pdfDeck, "slides").map((slide) => record(slide, "pdf slide"));
    const pdfStage = await openStage({
      context,
      stageOrigin,
      privateOrigin,
      consoleOrigin,
      upload: pdfUpload201,
      csrfToken,
      cookie,
      actions,
    });
    const firstPdfImage = pdfStage.page.getByRole("img", { name: /custom static deck.*slide 1/i });
    await firstPdfImage.waitFor();
    await firstPdfImage.evaluate(async (image) => {
      if (image instanceof HTMLImageElement && !image.complete) await image.decode();
    });
    const staticRuntimeCount = await pdfStage.page.locator("[data-slide-runtime]").count();
    if (staticRuntimeCount !== 0) {
      throw new Error("PDF unexpectedly mounted the animated runtime");
    }
    const pdfComputedOpacity = Number(
      await firstPdfImage.evaluate((element) => getComputedStyle(element).opacity),
    );
    const firstPageVisible = await firstPdfImage.isVisible();
    await captureScreenshot(pdfStage.page, "stage-pdf-static-page-1.png", screenshots);
    actions.push("Stage displayed PDF page 1 through the static image fallback");
    const secondPageReady = pdfStage.page
      .getByRole("img", { name: /custom static deck.*slide 2/i })
      .waitFor();
    await pdfStage.page.keyboard.press("ArrowRight");
    await secondPageReady;
    const secondPdfImage = pdfStage.page.getByRole("img", { name: /custom static deck.*slide 2/i });
    await secondPdfImage.evaluate(async (image) => {
      if (image instanceof HTMLImageElement && !image.complete) await image.decode();
    });
    await captureScreenshot(pdfStage.page, "stage-pdf-static-page-2.png", screenshots);
    actions.push("Stage displayed PDF page 2 through static image navigation");

    evidence = {
      environment: {
        consoleOrigin,
        sofficePath,
        libreOfficeVersion,
        fontPath,
        fontVersion,
        fontSha256,
        fixtureSha256,
      },
      httpResponses: {
        signIn201: record(redacted(signInBody), "redacted sign-in response"),
        pptxUpload201: record(redacted(pptxUpload201), "redacted PPTX response"),
        pdfUpload201: record(redacted(pdfUpload201), "redacted PDF response"),
      },
      signIn201,
      pptxUpload201: {
        status: pptxUpload.status,
        presentationSessionId: stringField(pptxUpload201, "presentationSessionId"),
        deckVersion: stringField(pptxUpload201, "deckVersion"),
      },
      pdfUpload201: {
        status: pdfUpload.status,
        presentationSessionId: stringField(pdfUpload201, "presentationSessionId"),
        deckVersion: stringField(pdfUpload201, "deckVersion"),
      },
      presentationReady: [
        stringField(pptxUpload201, "presentationSessionId"),
        stringField(pdfUpload201, "presentationSessionId"),
      ],
      pptx: {
        slideCount: pptxSlides.length,
        dimensions: {
          width: Number(pptxImage.width),
          height: Number(pptxImage.height),
        },
        stageBoundingBox: boundingBox,
        svgViewBox: stageGeometry.svgViewBox,
        renderedLabels: stageGeometry.renderedLabels,
        effectClasses,
        clickGroups: clickGroups.length,
        transition: stringField(objectField(pptxTimeline, "transition"), "kind"),
        transitionComplete,
        computedOpacity,
        font: {
          family: embeddedFont.family,
          httpStatus: fontStatus,
          readiness: fontEvidence.readiness,
          faceStatus: fontEvidence.faceStatus,
          check: fontEvidence.check,
          computedFamily: fontEvidence.computedFamily,
          byteSize: fontEvidence.byteSize,
          sha256: fontEvidence.sha256,
        },
        clickGroupEvidence,
        runtimeGroupsAdvanced,
      },
      pdf: {
        pageCount: pdfSlides.length,
        dimensions: pdfSlides.map((slide) => {
          const image = objectField(slide, "image");
          return { width: Number(image.width), height: Number(image.height) };
        }),
        staticRuntimeCount,
        computedOpacity: pdfComputedOpacity,
        firstPageVisible,
        secondPageVisible: await secondPdfImage.isVisible(),
        navigation: {
          fromPublicSlideKey: stringField(pdfSlides[0] ?? {}, "publicSlideKey"),
          toPublicSlideKey: stringField(pdfSlides[1] ?? {}, "publicSlideKey"),
        },
      },
      screenshots,
      actions,
    };
    await pdfStage.page.close();
  } finally {
    if (browser !== null) {
      await browser.close();
      cleanup.push("browser closed");
    }
    stageServer?.stop(true);
    cleanup.push("browser origins stopped");
    for (const child of processes.toReversed()) await stopProcess(child);
    cleanup.push("backend and gateway stopped");
    rmSync(runtimeRoot, { recursive: true, force: true });
    cleanup.push("temporary staging, snapshots, and promoted assets removed");
  }

  if (evidence === null) throw new Error("custom deck E2E completed without evidence");
  const complete: CustomDeckUploadEvidence = { ...evidence, cleanup };
  const actionLogPath = join(evidenceRoot, "action-log.json");
  await Bun.write(actionLogPath, `${JSON.stringify(complete, null, 2)}\n`);
  await runCommand([resolve("node_modules/.bin/biome"), "format", "--write", actionLogPath]);
  return complete;
}

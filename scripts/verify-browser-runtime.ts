import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { extname, join, resolve } from "node:path";
import type { Readable } from "node:stream";

import { type BrowserContext, chromium, type Page } from "playwright-core";
import { build as buildVite, createServer as createViteServer, preview } from "vite";

import { withBrowserRuntimeWorkspace } from "./browser-runtime-workspace.ts";
import {
  waitForFirstServiceWorkerActivation,
  waitForInstalledServiceWorkerUpdate,
} from "./service-worker-activation.ts";

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

// An empty CHROME_EXECUTABLE_PATH (`.env` ships it blank) must fall back to the installed
// Playwright Chromium: the variable is present, so `??` alone would leave a literal "" path.
const configuredChromeExecutable = process.env.CHROME_EXECUTABLE_PATH;
const chromeExecutable =
  configuredChromeExecutable === undefined || configuredChromeExecutable === ""
    ? chromium.executablePath()
    : configuredChromeExecutable;
const chromeHeadless = process.env.BROWSER_HEADED !== "true";
const stagePort = await availablePort();
const embedPort = await availablePort();
const consolePort = await availablePort();
const consoleBackendPort = await availablePort();
const consoleOrigin = `http://127.0.0.1:${consolePort}`;
const consoleDistDir = `.next-browser-runtime-${process.pid}`;
const consoleTsconfig = `.tsconfig-browser-runtime-${process.pid}.json`;
const devPorts = [await availablePort(), await availablePort()] as const;
const lifecyclePorts = [await availablePort(), await availablePort()] as const;
let runtimeRoot: string;
let profilePath: string;
export let artifactPath: string;

interface AppSurface {
  app: "console" | "stage";
  cachePrefix: string;
  readySelector: string;
  port: number;
  route: string;
}

interface LifecycleOrigin {
  close: () => Promise<void>;
  setWorkerVersion: (version: string) => void;
  url: string;
}

type CleanupTask = () => Promise<void> | void;

class CleanupStack {
  readonly #tasks: Array<() => Promise<void>> = [];

  add(task: CleanupTask) {
    let result: Promise<void> | null = null;
    const run = () => {
      result ??= Promise.resolve().then(task);
      return result;
    };
    this.#tasks.push(run);
    return run;
  }

  async runAll() {
    const errors: unknown[] = [];
    for (const task of this.#tasks.toReversed()) {
      try {
        await task();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Browser verifier cleanup failed");
    }
  }
}

const surfaces: AppSurface[] = [
  {
    app: "stage",
    cachePrefix: "impromptu-stage-shell-",
    // Stage is slide-only, so shell readiness is proven by the display container's own readiness
    // attribute instead of copy. Card absence itself is asserted by the security and projection suites.
    readySelector: "[data-audience-readiness]",
    port: stagePort,
    route: "/display/rehearsal",
  },
];

function address(surface: AppSurface) {
  return `http://127.0.0.1:${surface.port}${surface.route}`;
}

function runtimeDistributionRoot(surface: AppSurface) {
  return join(runtimeRoot, "distributions", surface.app);
}

async function buildRuntimeDistributions() {
  const previousNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    for (const surface of surfaces) {
      await buildVite({
        root: `apps/${surface.app}`,
        mode: "production",
        build: {
          emptyOutDir: true,
          outDir: runtimeDistributionRoot(surface),
        },
      });
    }
  } finally {
    if (previousNodeEnvironment === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnvironment;
    }
  }
  console.log("Built isolated production distribution for Stage.");
  await buildConsoleDistribution();
  console.log("Built the production Console (Next.js) for accessibility checks.");
}

async function verifyDevResponseHeaders() {
  for (const [index, surface] of surfaces.entries()) {
    const port = devPorts[index];
    if (port === undefined) throw new Error("dev verifier port missing");
    const server = await createViteServer({
      optimizeDeps: { noDiscovery: true },
      root: `apps/${surface.app}`,
      server: { host: "127.0.0.1", port, strictPort: true },
    });
    await server.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const policy = response.headers.get("content-security-policy");
      if (!policy?.includes("frame-ancestors 'none'")) {
        throw new Error(`${surface.app} dev response is missing frame-ancestors denial`);
      }
    } finally {
      await server.close();
    }
  }
  console.log("Stage dev response enforces frame-ancestors denial.");
}

async function startEmbedOrigin(): Promise<Server> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      `<!doctype html><title>Embed verifier</title><iframe src="http://127.0.0.1:${stagePort}/"></iframe>`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(embedPort, "127.0.0.1", resolve);
  });
  return server;
}

async function closeHttpServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

type ServiceProcess = ReturnType<typeof spawn>;

async function waitForOutput(
  stream: Readable,
  expected: string,
  timeoutMs = 30_000,
): Promise<void> {
  await new Promise<void>((resolveWait, rejectWait) => {
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
      rejectWait(new Error(`process exited before ${expected}: ${output}`));
    };
    const onAbort = () => {
      cleanup();
      rejectWait(new Error(`process did not emit ${expected}: ${output}`));
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runCommand(
  command: readonly string[],
  cwd: string,
  environment = process.env,
): Promise<void> {
  const executable = command[0];
  if (executable === undefined) throw new Error("empty command");
  const child = spawn(executable, command.slice(1), {
    cwd,
    env: environment,
    stdio: "inherit",
  });
  const [code] = await once(child, "exit", { signal: AbortSignal.timeout(300_000) });
  if (code !== 0) throw new Error(`command failed (${String(code)}): ${command.join(" ")}`);
}

async function startServiceProcess(
  command: readonly string[],
  expected: string,
  environment = process.env,
): Promise<ServiceProcess> {
  const executable = command[0];
  if (executable === undefined) throw new Error("empty service command");
  const child = spawn(executable, command.slice(1), {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForOutput(child.stdout, expected, 60_000);
    return child;
  } catch (error) {
    child.kill();
    await once(child, "exit", { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
    throw error;
  }
}

async function stopServiceProcess(child: ServiceProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.kill();
  await exited;
}

// The authenticated fixture covers exactly what the Console asks a private backend for during
// these checks: session creation and the owner-scoped report read. Everything else stays a 404
// so an unexpected private fetch surfaces as a failure instead of silently succeeding.
const A11Y_REPORT_SESSION_ID = "ps_a11y";
const A11Y_SESSION_BODY = JSON.stringify({
  account: { accountId: "account_a11y", actorId: "actor_a11y" },
  csrfToken: "a11y-csrf",
  expiresAtMs: 4_102_444_800_000,
});
const A11Y_REPORT_BODY = JSON.stringify({
  report: {
    reportVersion: 1,
    presentationSessionId: A11Y_REPORT_SESSION_ID,
    ownerAccountId: "account_a11y",
    finalizedAtMs: 1_758_925_200_000,
    totalDurationMs: 46_000,
    slideVisits: [
      {
        sequence: 1,
        publicSlideKey: "slide_public_1",
        occurrenceSequence: 1,
        enteredOffsetMs: 0,
        leftOffsetMs: 46_000,
        dwellMs: 46_000,
        revisit: false,
      },
    ],
    speech: {
      derivedSummary: "발표 음성 요약",
      wordCount: 120,
      speakingDurationMs: 40_000,
      timingAggregate: { finalCount: 8, measuredFinalCount: 8 },
      coachingAggregate: {
        cueCount: 1,
        latestCurrentWordsPerMinute: 140,
        latestPreviousWordsPerMinute: null,
      },
    },
    preparedEvidence: { label: "준비된 근거", items: [] },
  },
});

function startConsoleFixtureBackend(): Promise<Server> {
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${consoleBackendPort}`);
    if (request.method === "POST" && url.pathname === "/v1/account-sessions") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "impromptu_session=a11y; Path=/; HttpOnly; SameSite=Strict",
      });
      response.end(A11Y_SESSION_BODY);
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === `/v1/presentation-sessions/${A11Y_REPORT_SESSION_ID}/report`
    ) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(A11Y_REPORT_BODY);
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "a11y_fixture_not_found" }));
  });
  return new Promise<Server>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(consoleBackendPort, "127.0.0.1", () => resolveListen(server));
  });
}

// The Console is a Next.js app, not a Vite PWA, so it cannot ride the `surfaces` pipeline
// (Vite build, preview origin, service-worker lifecycle). It is built once with `next build`
// into its gitignored .next output and served with `next start` for the accessibility matrix.
async function buildConsoleDistribution() {
  copyFileSync("apps/console/tsconfig.json", join("apps/console", consoleTsconfig));
  await runCommand(["bun", "run", "build"], "apps/console", {
    ...process.env,
    IMPROMPTU_NEXT_DIST_DIR: consoleDistDir,
    IMPROMPTU_NEXT_TSCONFIG: consoleTsconfig,
  });
}

async function startConsoleOrigin(): Promise<ServiceProcess> {
  return startServiceProcess(
    [
      "node",
      "apps/console/node_modules/next/dist/bin/next",
      "start",
      "apps/console",
      "--port",
      String(consolePort),
    ],
    "Ready in",
    {
      ...process.env,
      NODE_ENV: "production",
      // Loopback fixture origin: production demands HTTPS only for browser-routed hops; the
      // server-to-server proxy hop may be cleartext on 127.0.0.1.
      CONSOLE_PRIVATE_API_ORIGIN: `http://127.0.0.1:${consoleBackendPort}`,
      STAGE_ORIGIN: `http://127.0.0.1:${stagePort}`,
      IMPROMPTU_NEXT_DIST_DIR: consoleDistDir,
      IMPROMPTU_NEXT_TSCONFIG: consoleTsconfig,
    },
  );
}

async function startLifecycleOrigin(surface: AppSurface, port: number): Promise<LifecycleOrigin> {
  const distributionRoot = runtimeDistributionRoot(surface);
  const baseWorker = readFileSync(join(distributionRoot, "sw.js"), "utf8");
  const baseCacheName = baseWorker.match(/const CACHE_NAME = "([^"]+)"/)?.[1];
  const deploymentHeaders = readFileSync(join(distributionRoot, "_headers"), "utf8");
  const policy = deploymentHeaders.match(/Content-Security-Policy: (.+)/)?.[1];
  if (!baseCacheName || !policy) {
    throw new Error(`${surface.app} lifecycle fixture is missing build metadata`);
  }

  let workerSource = baseWorker;
  const server = createHttpServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (requestUrl.pathname === "/sw.js") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/javascript",
        "Service-Worker-Allowed": "/",
      });
      response.end(workerSource);
      return;
    }

    const requestedFile = extname(requestUrl.pathname) ? requestUrl.pathname : "/index.html";
    const filePath = resolve(distributionRoot, `.${requestedFile}`);
    if (!filePath.startsWith(distributionRoot) || !existsSync(filePath)) {
      response.writeHead(404);
      response.end();
      return;
    }

    const contentTypes: Record<string, string> = {
      ".css": "text/css",
      ".html": "text/html",
      ".js": "text/javascript",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".webmanifest": "application/manifest+json",
    };
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": policy,
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    });
    response.end(readFileSync(filePath));
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });

  return {
    close: () => closeHttpServer(server),
    setWorkerVersion(version) {
      workerSource = baseWorker.replace(
        `const CACHE_NAME = "${baseCacheName}"`,
        `const CACHE_NAME = "${baseCacheName}-lifecycle-${version}"`,
      );
    },
    url: `http://127.0.0.1:${port}`,
  };
}

async function clearHttpCache(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.clearBrowserCache");
  await session.detach();
}

async function installOfflineShell(context: BrowserContext, surface: AppSurface) {
  console.log(`Installing ${surface.app} offline shell...`);
  const page = await context.newPage();
  const response = await page.goto(address(surface), { waitUntil: "domcontentloaded" });
  await page.evaluate(waitForFirstServiceWorkerActivation, {
    scriptUrl: "/sw.js?cohort=stable",
    timeoutMs: 10_000,
  });
  await page.locator(surface.readySelector).waitFor({ state: "visible" });
  const policy = await response?.headerValue("content-security-policy");
  if (!policy?.includes("frame-ancestors 'none'")) {
    throw new Error(`${surface.app} preview response is missing frame-ancestors denial`);
  }
  const shell = await page.evaluate(async (cachePrefix) => {
    const cacheName = (await caches.keys()).find((key) => key.startsWith(cachePrefix));
    if (!cacheName) {
      return null;
    }
    const requests = await (await caches.open(cacheName)).keys();
    return {
      cacheName,
      urls: requests.map((request) => new URL(request.url).pathname),
    };
  }, surface.cachePrefix);

  if (!shell?.urls.some((url) => /\/assets\/[^/]+-[^/]+\.js$/.test(url))) {
    throw new Error(`${surface.app} cold cache is missing versioned JavaScript`);
  }
  if (!shell.urls.some((url) => /\/assets\/[^/]+-[^/]+\.css$/.test(url))) {
    throw new Error(`${surface.app} cold cache is missing versioned CSS`);
  }

  if (surface.app === "stage") {
    const canary = "FOREIGN_CACHE_CANARY_MUST_NOT_RENDER";
    await page.evaluate(
      async ({ cacheName, documentUrl, marker }) => {
        const foreignCache = await caches.open(cacheName);
        await foreignCache.put(
          documentUrl,
          new Response(`<main>${marker}</main>`, { headers: { "Content-Type": "text/html" } }),
        );
      },
      { cacheName: "foreign-stale-canary", documentUrl: address(surface), marker: canary },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(surface.readySelector).waitFor({ state: "visible" });
    if ((await page.locator("body").innerText()).includes(canary)) {
      throw new Error("Stage rendered a stale document from a foreign cache");
    }
    await page.evaluate(async () => caches.delete("foreign-stale-canary"));
    console.log("Stage rejected the stale foreign-cache canary.");
  }

  await clearHttpCache(context, page);
  await page.close();
  console.log(`Installed ${surface.app} offline shell (${shell.urls.length} entries).`);
}

async function waitForWaitingUpdate(page: Page) {
  return page.evaluate(waitForInstalledServiceWorkerUpdate, { timeoutMs: 10_000 });
}

async function readServiceWorkerReleasePin(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const worker = registration?.active;
    if (!worker) throw new Error("active service worker is missing its release pin");

    const pin = await new Promise<{ buildId: string; cohort: string }>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(
        () => reject(new Error("service worker release pin response timed out")),
        10_000,
      );
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        window.clearTimeout(timeout);
        channel.port1.close();
        channel.port2.close();
        const value = event.data;
        if (
          typeof value !== "object" ||
          value === null ||
          !("cohort" in value) ||
          typeof value.cohort !== "string" ||
          !("buildId" in value) ||
          typeof value.buildId !== "string"
        ) {
          reject(new Error("service worker returned an invalid release pin"));
          return;
        }
        resolve({ cohort: value.cohort, buildId: value.buildId });
      };
      worker.postMessage({ type: "IMPROMPTU_GET_RELEASE_PIN" }, [channel.port2]);
    });
    return {
      ...pin,
      scriptCohort: new URL(worker.scriptURL).searchParams.get("cohort"),
    };
  });
}

async function waitForUpdateCoordinator(page: Page) {
  return page.evaluate(async () => {
    const ready = Reflect.get(window, "__browserRuntimeUpdateCoordinatorReady");
    if (!(ready instanceof Promise)) {
      throw new Error("Update coordinator readiness listener was not prepared");
    }

    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        const signal = AbortSignal.timeout(10_000);
        signal.addEventListener(
          "abort",
          () => reject(new Error("Update coordinator readiness timed out")),
          { once: true },
        );
      }),
    ]);
  });
}

async function dispatchActivationAndWait(page: Page, eventName: string) {
  return page.evaluate(async (activationEvent) => {
    const previousController = navigator.serviceWorker.controller;
    await new Promise<void>((resolveChange, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error(`Controller change timed out for ${activationEvent}`)),
        10_000,
      );
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          const controller = navigator.serviceWorker.controller;
          if (!controller || controller === previousController) {
            window.clearTimeout(timeout);
            reject(new Error("Controllerchange did not install the new worker"));
            return;
          }

          const inspectState = () => {
            if (controller.state === "activated") {
              window.clearTimeout(timeout);
              controller.removeEventListener("statechange", inspectState);
              resolveChange();
            } else if (controller.state === "redundant") {
              window.clearTimeout(timeout);
              controller.removeEventListener("statechange", inspectState);
              reject(new Error("New controller became redundant during activation"));
            }
          };
          controller.addEventListener("statechange", inspectState);
          inspectState();
        },
        { once: true },
      );
      window.dispatchEvent(new CustomEvent(activationEvent));
    });

    const registration = await navigator.serviceWorker.getRegistration();
    return {
      active: registration?.active?.state,
      controllerChanges: (window as unknown as { __controllerChanges: number }).__controllerChanges,
      waiting: registration?.waiting !== null,
    };
  }, eventName);
}

async function verifyUpdateLifecycle(surface: AppSurface, index: number) {
  const cleanup = new CleanupStack();
  const lifecycleProfile = join(runtimeRoot, `${surface.app}-lifecycle-profile`);

  try {
    const port = lifecyclePorts[index];
    if (port === undefined) throw new Error("lifecycle verifier port missing");
    const origin = await startLifecycleOrigin(surface, port);
    cleanup.add(origin.close);
    origin.setWorkerVersion("v1");
    const context = await chromium.launchPersistentContext(lifecycleProfile, {
      executablePath: chromeExecutable,
      headless: chromeHeadless,
      serviceWorkers: "allow",
    });
    const closeContext = cleanup.add(() => context.close());
    await context.addInitScript(() => {
      (window as unknown as { __controllerChanges: number }).__controllerChanges = 0;
      Reflect.set(
        window,
        "__browserRuntimeUpdateCoordinatorReady",
        new Promise<void>((resolve) => {
          window.addEventListener("impromptu:update-coordinator-ready", () => resolve(), {
            once: true,
          });
        }),
      );
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        (window as unknown as { __controllerChanges: number }).__controllerChanges += 1;
      });
    });

    const page = await context.newPage();
    await page.goto(`${origin.url}${surface.route}`, { waitUntil: "domcontentloaded" });
    await page.evaluate(waitForFirstServiceWorkerActivation, {
      scriptUrl: "/sw.js?cohort=stable",
      timeoutMs: 10_000,
    });
    await page.locator(surface.readySelector).waitFor({ state: "visible" });
    const firstInstall = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return {
        active: registration?.active?.state,
        controlled: navigator.serviceWorker.controller !== null,
        controllerChanges: (window as unknown as { __controllerChanges: number })
          .__controllerChanges,
      };
    });
    if (
      firstInstall.active !== "activated" ||
      firstInstall.controlled ||
      firstInstall.controllerChanges !== 0
    ) {
      throw new Error(`${surface.app} first install unexpectedly took over its active tab`);
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(surface.readySelector).waitFor({ state: "visible" });
    const controlledAfterRefresh = await page.evaluate(
      () => navigator.serviceWorker.controller !== null,
    );
    const refreshPin = await readServiceWorkerReleasePin(page);
    if (
      !controlledAfterRefresh ||
      refreshPin.cohort !== "stable" ||
      refreshPin.scriptCohort !== "stable"
    ) {
      throw new Error(`${surface.app} first worker did not retain its cohort after refresh`);
    }
    await waitForUpdateCoordinator(page);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("impromptu:presentation-session-started"));
    });
    origin.setWorkerVersion("v2");
    const beforeConfirmation = await page.evaluate(
      () => (window as unknown as { __controllerChanges: number }).__controllerChanges,
    );
    const waitingForConfirmation = await waitForWaitingUpdate(page);
    const afterWaitingForConfirmation = await page.evaluate(async () => ({
      changes: (window as unknown as { __controllerChanges: number }).__controllerChanges,
      waiting: (await navigator.serviceWorker.getRegistration())?.waiting !== null,
    }));
    if (
      waitingForConfirmation.state !== "installed" ||
      !waitingForConfirmation.waiting ||
      !afterWaitingForConfirmation.waiting ||
      afterWaitingForConfirmation.changes !== beforeConfirmation
    ) {
      throw new Error(`${surface.app} update did not remain waiting during an active session`);
    }

    const operatorActivation = await dispatchActivationAndWait(
      page,
      "impromptu:update-operator-confirmed",
    );
    if (
      operatorActivation.active !== "activated" ||
      operatorActivation.waiting ||
      operatorActivation.controllerChanges !== beforeConfirmation + 1
    ) {
      throw new Error(
        `${surface.app} operator-confirmed activation handshake failed: ${JSON.stringify(operatorActivation)}`,
      );
    }

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("impromptu:presentation-session-started"));
    });
    origin.setWorkerVersion("v3");
    const beforeSessionEnd = operatorActivation.controllerChanges;
    const waitingForSessionEnd = await waitForWaitingUpdate(page);
    const stillDeferred = await page.evaluate(async () => ({
      changes: (window as unknown as { __controllerChanges: number }).__controllerChanges,
      waiting: (await navigator.serviceWorker.getRegistration())?.waiting !== null,
    }));
    if (
      !waitingForSessionEnd.waiting ||
      !stillDeferred.waiting ||
      stillDeferred.changes !== beforeSessionEnd
    ) {
      throw new Error(`${surface.app} session-end update was not deferred`);
    }

    const sessionEndActivation = await dispatchActivationAndWait(
      page,
      "impromptu:presentation-session-ended",
    );
    if (
      sessionEndActivation.active !== "activated" ||
      sessionEndActivation.waiting ||
      sessionEndActivation.controllerChanges !== beforeSessionEnd + 1
    ) {
      throw new Error(
        `${surface.app} session-end activation handshake failed: ${JSON.stringify(sessionEndActivation)}`,
      );
    }
    await page.screenshot({
      path: join(artifactPath, `${surface.app}-update-session-ended.png`),
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(surface.readySelector).waitFor({ state: "visible" });
    if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) {
      throw new Error(`${surface.app} activated update did not survive refresh`);
    }
    await closeContext();

    const restartContext = await chromium.launchPersistentContext(lifecycleProfile, {
      executablePath: chromeExecutable,
      headless: chromeHeadless,
      serviceWorkers: "allow",
    });
    cleanup.add(() => restartContext.close());
    const restartPage = await restartContext.newPage();
    await restartPage.goto(`${origin.url}${surface.route}`, { waitUntil: "domcontentloaded" });
    await restartPage.locator(surface.readySelector).waitFor({ state: "visible" });
    const restartState = await restartPage.evaluate(
      async (cachePrefix) => ({
        cacheNames: (await caches.keys()).filter((name) => name.startsWith(cachePrefix)),
        controlled: navigator.serviceWorker.controller !== null,
      }),
      surface.cachePrefix,
    );
    const restartPin = await readServiceWorkerReleasePin(restartPage);
    if (
      !restartState.controlled ||
      restartState.cacheNames.length !== 1 ||
      !restartState.cacheNames[0]?.includes("-stable-") ||
      !restartState.cacheNames[0]?.endsWith("lifecycle-v3") ||
      restartPin.cohort !== "stable" ||
      restartPin.scriptCohort !== "stable"
    ) {
      throw new Error(`${surface.app} latest cohort pin did not survive a cold browser restart`);
    }
    await restartPage.screenshot({
      path: join(artifactPath, `${surface.app}-update-cold-restart.png`),
    });
    console.log(`${surface.app} update lifecycle deferred and activated safely.`);
  } finally {
    try {
      await cleanup.runAll();
    } finally {
      rmSync(lifecycleProfile, { force: true, recursive: true });
    }
  }
}

async function verifyUpdateLifecycles() {
  for (const [index, surface] of surfaces.entries()) {
    await verifyUpdateLifecycle(surface, index);
  }
}

async function assertStageFitsViewport(
  page: Page,
  label: string,
  criticalSelectors: readonly string[],
  removedSelectors: readonly string[] = [],
) {
  // Measure the settled layout, not the ui-reveal entrance frame: transforms count in
  // getBoundingClientRect, so a mid-animation read reports a transient clip.
  await page.evaluate(async () => {
    await Promise.race([
      Promise.allSettled(document.getAnimations().map((animation) => animation.finished)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  });
  const result = await page.evaluate(
    ({ critical, removed }) => {
      const viewport = { height: window.innerHeight, width: window.innerWidth };
      const clipped = critical.flatMap((selector) =>
        [...document.querySelectorAll(selector)].flatMap((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top < 0 ||
            rect.left < 0 ||
            rect.bottom > viewport.height ||
            rect.right > viewport.width
            ? [selector]
            : [];
        }),
      );
      return {
        clipped,
        documentHeight: document.documentElement.scrollHeight,
        missing: critical.filter((selector) => document.querySelector(selector) === null),
        present: removed.filter((selector) => document.querySelector(selector) !== null),
        viewport,
      };
    },
    { critical: [...criticalSelectors], removed: [...removedSelectors] },
  );

  if (result.missing.length > 0 || result.present.length > 0) {
    throw new Error(
      `${label} rendered the wrong Stage surface: ` +
        `missing=${result.missing.join(",") || "none"}, ` +
        `resurrected=${result.present.join(",") || "none"}`,
    );
  }
  if (result.documentHeight > result.viewport.height || result.clipped.length > 0) {
    throw new Error(
      `${label} overflowed ${result.viewport.width}x${result.viewport.height}: ` +
        `document=${result.documentHeight}, clipped=${result.clipped.join(",")}`,
    );
  }
}

async function verifyStageLayouts(context: BrowserContext) {
  const viewports = [
    { height: 900, label: "1440x900", width: 1440 },
    { height: 900, label: "768x900", width: 768 },
    { height: 800, label: "320x800", width: 320 },
    { height: 450, label: "200-percent-equivalent", width: 720 },
  ] as const;
  // Slide-only Stage: no chrome, no fullscreen/placement buttons, no pairing scaffolding. The
  // landing route without a Console opener is the deliberate inert notice (`stage-console-only`);
  // the display route is the audience surface itself.
  const routes = [
    {
      critical: ["main.stage-console-only"],
      name: "landing",
      path: "/",
      removed: [
        "[data-stage-fullscreen]",
        "[data-stage-placement]",
        "[data-stage-chrome='visible']",
        ".stage-evidence",
      ],
    },
    {
      critical: ["[data-audience-readiness]", ".stage-display__content", ".stage-claim"],
      name: "display",
      path: "/display/rehearsal",
      removed: [
        "[data-stage-fullscreen]",
        "[data-stage-placement]",
        "[data-stage-chrome='visible']",
        ".stage-display__bar",
        ".stage-display__actions",
        ".stage-evidence",
      ],
    },
  ] as const;

  for (const viewport of viewports) {
    for (const route of routes) {
      const page = await context.newPage();
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await page.goto(`http://127.0.0.1:${stagePort}${route.path}`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("#root").waitFor({ state: "visible" });
      await page.locator(route.critical[0]).waitFor({ state: "visible" });
      await assertStageFitsViewport(
        page,
        `${route.name}-${viewport.label}`,
        route.critical,
        route.removed,
      );
      await page.screenshot({
        path: join(artifactPath, `stage-${route.name}-${viewport.label}.png`),
      });
      await page.close();
    }
  }

  // Placement is a published outcome, not a control: the display announces it on mount through
  // `impromptu:target-screen-placement` and an assistive-only live region. Headless single-screen
  // Chrome can only ever reach MANUAL_FALLBACK; TARGET_PLACED requires a physical second screen.
  const placementPage = await context.newPage();
  await placementPage.setViewportSize({ height: 900, width: 1440 });
  await placementPage.addInitScript(() => {
    Reflect.set(window, "__runtimePlacementRecords", []);
    window.addEventListener("impromptu:target-screen-placement", (event) => {
      const records = Reflect.get(window, "__runtimePlacementRecords") as unknown[];
      records.push(event instanceof CustomEvent ? event.detail : null);
    });
  });
  await placementPage.goto(`http://127.0.0.1:${stagePort}/display/rehearsal`, {
    waitUntil: "domcontentloaded",
  });
  await placementPage.locator("[data-audience-readiness]").waitFor({ state: "visible" });
  const placementDetail = await placementPage.evaluate(async () => {
    const records = Reflect.get(window, "__runtimePlacementRecords") as unknown[];
    if (records.length === 0) {
      const observed = await new Promise<unknown>((resolveObserve, rejectObserve) => {
        const signal = AbortSignal.timeout(10_000);
        window.addEventListener(
          "impromptu:target-screen-placement",
          (event) => resolveObserve(event instanceof CustomEvent ? event.detail : null),
          { once: true },
        );
        signal.addEventListener(
          "abort",
          () => rejectObserve(new Error("target-screen placement was never published")),
          { once: true },
        );
      });
      records.push(observed);
    }
    return records[0];
  });
  if (
    typeof placementDetail !== "object" ||
    placementDetail === null ||
    !["TARGET_PLACED", "TARGET_LOST_RECOVERED", "MANUAL_FALLBACK"].includes(
      String((placementDetail as Record<string, unknown>).status),
    ) ||
    (placementDetail as Record<string, unknown>).privatePixelCount !== 0
  ) {
    throw new Error(
      `Stage did not publish a clean target-screen placement outcome: ${JSON.stringify(placementDetail)}`,
    );
  }
  const placementAnnouncement = (
    await placementPage.locator(".stage-display [aria-live='polite']").textContent()
  )?.trim();
  if (placementAnnouncement === undefined || placementAnnouncement === "") {
    throw new Error("Stage did not publish a placement summary for assistive technology");
  }
  if ((await placementPage.locator("[data-stage-fullscreen]").count()) !== 0) {
    throw new Error("Stage reintroduced a local fullscreen control");
  }
  await placementPage.screenshot({ path: join(artifactPath, "stage-placement-outcome.png") });
  await placementPage.close();
  console.log("Stage slide-only layout and published placement outcome fit every viewport.");
}

interface AccessibilityRoute {
  app: AppSurface["app"];
  authenticated?: boolean;
  /** Selectors that must carry a visible forced-colors border; null skips the check. */
  forcedColorsSelector: string | null;
  /** Exact expected landmark counts; the slide-only Stage landing is deliberately h1-free. */
  landmarks: { readonly h1: number; readonly main: number; readonly nav: number };
  name: string;
  path: string;
  /** Extra element to await before asserting, beyond the always-required `main`. */
  readySelector?: string;
}

const CONSOLE_FORCED_COLORS = ".ui-button, .ui-panel, .ui-brand__mark, .ui-badge";

const accessibilityRoutes: readonly AccessibilityRoute[] = [
  {
    app: "console",
    forcedColorsSelector: CONSOLE_FORCED_COLORS,
    landmarks: { h1: 1, main: 1, nav: 0 },
    name: "sign-in",
    path: "/sign-in",
  },
  {
    app: "console",
    authenticated: true,
    forcedColorsSelector: CONSOLE_FORCED_COLORS,
    landmarks: { h1: 1, main: 1, nav: 0 },
    name: "workspace",
    path: "/",
  },
  {
    app: "console",
    authenticated: true,
    forcedColorsSelector: CONSOLE_FORCED_COLORS,
    landmarks: { h1: 1, main: 1, nav: 0 },
    name: "session",
    path: "/session",
  },
  {
    app: "console",
    authenticated: true,
    forcedColorsSelector: CONSOLE_FORCED_COLORS,
    landmarks: { h1: 1, main: 1, nav: 1 },
    name: "report",
    path: `/reports/${A11Y_REPORT_SESSION_ID}`,
    readySelector: "[data-presentation-report='ready']",
  },
  {
    app: "stage",
    forcedColorsSelector: null,
    landmarks: { h1: 0, main: 1, nav: 0 },
    name: "landing",
    path: "/",
  },
  {
    app: "stage",
    forcedColorsSelector: null,
    landmarks: { h1: 1, main: 1, nav: 0 },
    name: "display",
    path: "/display/rehearsal",
  },
];

function accessibilityOrigin(route: AccessibilityRoute): string {
  if (route.app === "console") return consoleOrigin;
  const surface = surfaces.find((candidate) => candidate.app === route.app);
  if (!surface) throw new Error(`missing accessibility surface for ${route.app}`);
  return `http://127.0.0.1:${surface.port}`;
}

// Authenticated Console routes exist only inside the running SPA (sessions live in memory and
// RequireAuth bounces unauthenticated loads), so each check signs in through the real form and
// `/v1` proxy, then navigates in-app with pushState + popstate exactly like a link activation.
async function signInConsoleFixture(page: Page) {
  await page.goto(`${consoleOrigin}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-sign-in-username]").fill("a11y-presenter");
  await page.locator("[data-sign-in-password]").fill("a11y-presenter-password");
  await page.locator("[data-sign-in-submit]").click();
  await page.locator("[data-co-resident-state]").waitFor({ state: "attached" });
}

async function navigateConsoleRoute(page: Page, path: string) {
  await page.evaluate((target) => {
    window.history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function openAccessibilityRoute(context: BrowserContext, route: AccessibilityRoute) {
  const origin = accessibilityOrigin(route);
  const page = await context.newPage();

  if (route.app === "console" && route.authenticated === true) {
    await signInConsoleFixture(page);
    if (route.path !== "/") await navigateConsoleRoute(page, route.path);
  } else {
    await page.goto(`${origin}${route.path}`, { waitUntil: "domcontentloaded" });
  }
  await page.locator("main").waitFor({ state: "visible" });
  if (route.readySelector !== undefined) {
    await page.locator(route.readySelector).waitFor({ state: "visible" });
  }
  return page;
}

async function assertAccessibilityStructure(page: Page, route: AccessibilityRoute) {
  const structure = await page.evaluate(() => {
    const nameOf = (element: Element) =>
      element.getAttribute("aria-label") ??
      element.getAttribute("alt") ??
      element.textContent?.trim() ??
      "";
    const unlabeledControls = [...document.querySelectorAll("button, a[href], input")]
      .filter((element) => {
        if (element instanceof HTMLInputElement && element.labels?.length) return false;
        return nameOf(element).length === 0;
      })
      .map((element) => element.outerHTML);
    const imagesWithoutAlt = [...document.querySelectorAll("img")]
      .filter((image) => !image.hasAttribute("alt"))
      .map((image) => image.outerHTML);
    return {
      h1Count: document.querySelectorAll("h1").length,
      imagesWithoutAlt,
      mainCount: document.querySelectorAll("main").length,
      navigationCount: document.querySelectorAll("nav").length,
      unlabeledControls,
    };
  });

  if (
    structure.mainCount !== route.landmarks.main ||
    structure.h1Count !== route.landmarks.h1 ||
    structure.navigationCount !== route.landmarks.nav ||
    structure.unlabeledControls.length > 0 ||
    structure.imagesWithoutAlt.length > 0
  ) {
    throw new Error(
      `${route.app}/${route.name} landmark or label failure: ${JSON.stringify(structure)}`,
    );
  }
}

async function assertKeyboardFocusOrder(page: Page, route: AccessibilityRoute) {
  const focusableCount = await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    // Chrome's sequential tab order covers more than focusable selectors: any element that has
    // become a scroll container (overflow not visible/clip AND actually overflowing) is also a
    // tab stop, exactly where it sits in the DOM. Model both so the traversal expectation
    // matches what the browser really does.
    const scrollable = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      // Scroll containers for tab order are the CSS kind: auto/scroll only. overflow:hidden
      // clips without becoming a scroll container, and Chromium skips it.
      const scrolls = (value: string) => value === "auto" || value === "scroll";
      if (!scrolls(style.overflowX) && !scrolls(style.overflowY)) return false;
      return (
        element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth
      );
    };
    const candidates = [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => {
      if (
        getComputedStyle(element).visibility === "hidden" ||
        element.getClientRects().length === 0
      ) {
        return false;
      }
      return (
        element.matches(
          'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) || scrollable(element)
      );
    });
    candidates.forEach((element, index) => {
      element.dataset.a11yOrder = String(index);
    });
    return candidates.length;
  });

  for (let index = 0; index < focusableCount; index += 1) {
    await page.keyboard.press("Tab");
    const actual = await page.evaluate(() =>
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.a11yOrder
        : undefined,
    );
    if (actual !== String(index)) {
      const focusState = await page.evaluate(() => ({
        active: document.activeElement?.outerHTML,
        candidates: [...document.querySelectorAll<HTMLElement>("[data-a11y-order]")].map(
          (element) => element.outerHTML,
        ),
      }));
      throw new Error(
        `${route.app}/${route.name} focus order diverged at ${index}: ${actual}; ${JSON.stringify(focusState)}`,
      );
    }
  }
}

async function assertComputedContrast(page: Page, route: AccessibilityRoute) {
  const result = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("contrast canvas is unavailable");

    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
      return [red / 255, green / 255, blue / 255, alpha / 255] as const;
    };
    const composite = (foreground: readonly number[], background: readonly number[]) => {
      const alpha = foreground[3] ?? 1;
      return [
        (foreground[0] ?? 0) * alpha + (background[0] ?? 0) * (1 - alpha),
        (foreground[1] ?? 0) * alpha + (background[1] ?? 0) * (1 - alpha),
        (foreground[2] ?? 0) * alpha + (background[2] ?? 0) * (1 - alpha),
        1,
      ] as const;
    };
    const backgroundOf = (element: Element | null): readonly number[] => {
      if (!element) return [1, 1, 1, 1];
      const own = rgba(getComputedStyle(element).backgroundColor);
      return own[3] === 1 ? own : composite(own, backgroundOf(element.parentElement));
    };
    const luminance = (color: readonly number[]) => {
      const linear = color
        .slice(0, 3)
        .map((channel) =>
          channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        );
      return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
    };

    const renderedTextElements = [...document.body.querySelectorAll<HTMLElement>("*")].filter(
      (element) => {
        const hasDirectText = [...element.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        );
        const style = getComputedStyle(element);
        return (
          hasDirectText &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity) > 0 &&
          element.getClientRects().length > 0
        );
      },
    );
    const measurements = renderedTextElements.map((element) => {
      const style = getComputedStyle(element);
      const foreground = composite(rgba(style.color), backgroundOf(element));
      const background = backgroundOf(element);
      const lighter = Math.max(luminance(foreground), luminance(background));
      const darker = Math.min(luminance(foreground), luminance(background));
      const ratio = (lighter + 0.05) / (darker + 0.05);
      const fontSize = Number.parseFloat(style.fontSize);
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
      const threshold = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700) ? 3 : 4.5;
      return {
        element: `${element.tagName.toLowerCase()}.${element.className}`,
        ratio,
        threshold,
      };
    });
    const minimum = measurements.reduce(
      (current, measurement) => (measurement.ratio < current.ratio ? measurement : current),
      { element: "none", ratio: Number.POSITIVE_INFINITY, threshold: 4.5 },
    );
    const ratioFor = (className: string) => {
      const measurement = measurements.find(({ element }) => element.includes(className));
      return measurement ? Number(measurement.ratio.toFixed(3)) : null;
    };
    return {
      accentBadgeRatio: ratioFor("ui-badge--accent"),
      failures: measurements.flatMap((measurement) =>
        measurement.ratio + 0.01 < measurement.threshold
          ? [`${measurement.element}:${measurement.ratio.toFixed(3)}<${measurement.threshold}`]
          : [],
      ),
      minimum: { ...minimum, ratio: Number(minimum.ratio.toFixed(3)) },
      scannedCount: measurements.length,
      successBadgeRatio: ratioFor("ui-badge--success"),
    };
  });

  if (result.failures.length > 0) {
    throw new Error(`${route.app}/${route.name} contrast failures: ${result.failures.join(", ")}`);
  }
  return result;
}

async function assertAccessibilityMedia(page: Page, route: AccessibilityRoute) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const moving = await page.locator("*").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const style = getComputedStyle(element);
      const durations = [style.animationDuration, style.transitionDuration]
        .flatMap((value) => value.split(","))
        .map((value) =>
          value.trim().endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1_000,
        );
      return durations.some((duration) => duration > 1) ? [element.tagName.toLowerCase()] : [];
    }),
  );
  if (moving.length > 0) {
    throw new Error(`${route.app}/${route.name} reduced-motion failures: ${moving.join(",")}`);
  }

  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  // Routes that paint no interactive chrome (the slide-only Stage surfaces) have nothing to
  // check; controls-bearing routes must keep at least one bordered target.
  if (route.forcedColorsSelector === null) return;
  const forcedColorFailure = await page.locator(route.forcedColorsSelector).evaluateAll(
    (elements) =>
      elements.length === 0 ||
      elements.some((element) => {
        const style = getComputedStyle(element);
        return style.borderTopStyle === "none" || style.borderTopColor === "rgba(0, 0, 0, 0)";
      }),
  );
  if (forcedColorFailure) {
    throw new Error(`${route.app}/${route.name} forced-colors border fallback failed`);
  }
}

async function verifyAccessibilityMatrix(context: BrowserContext) {
  const contrastEvidence: string[] = [];
  for (const route of accessibilityRoutes) {
    const page = await openAccessibilityRoute(context, route);
    await assertAccessibilityStructure(page, route);
    await assertKeyboardFocusOrder(page, route);
    const contrast = await assertComputedContrast(page, route);
    const namedRatios = [
      contrast.accentBadgeRatio === null ? null : `accent ${contrast.accentBadgeRatio}:1`,
      contrast.successBadgeRatio === null ? null : `success ${contrast.successBadgeRatio}:1`,
    ].filter((value) => value !== null);
    contrastEvidence.push(
      `${route.app}/${route.name}=${contrast.scannedCount} text containers, minimum ${contrast.minimum.ratio}:1 (${contrast.minimum.element})${namedRatios.length > 0 ? `, ${namedRatios.join(", ")}` : ""}`,
    );
    await assertAccessibilityMedia(page, route);
    await page.screenshot({ path: join(artifactPath, `a11y-${route.app}-${route.name}.png`) });
    await page.close();
  }
  console.log(
    `Console and Stage accessibility route matrix passed: ${contrastEvidence.join("; ")}.`,
  );
}

async function verifyReducedMotion(context: BrowserContext) {
  for (const surface of surfaces) {
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(address(surface), { waitUntil: "domcontentloaded" });
    await page.locator(surface.readySelector).waitFor({ state: "visible" });
    const offenders = await page.locator("*").evaluateAll((elements) => {
      const toMilliseconds = (value: string) =>
        value.split(",").map((part) => {
          const duration = part.trim();
          return duration.endsWith("ms")
            ? Number.parseFloat(duration)
            : Number.parseFloat(duration) * 1000;
        });

      return elements.flatMap((element) => {
        const style = getComputedStyle(element);
        const durations = [
          ...toMilliseconds(style.animationDuration),
          ...toMilliseconds(style.animationDelay),
          ...toMilliseconds(style.transitionDuration),
          ...toMilliseconds(style.transitionDelay),
        ];
        return durations.some((duration) => duration > 1)
          ? [`${element.tagName.toLowerCase()}.${element.className}`]
          : [];
      });
    });
    if (offenders.length > 0) {
      throw new Error(`${surface.app} reduced-motion overrides missed: ${offenders.join(", ")}`);
    }
    await page.screenshot({ path: join(artifactPath, `${surface.app}-reduced-motion.png`) });
    await page.close();
  }
  console.log("Computed motion is at most 1ms under reduced-motion preference.");
}

async function verifyCrossOriginFrameRejection(context: BrowserContext) {
  const page = await context.newPage();
  const violation = page.waitForEvent("console", {
    predicate: (message) => message.text().includes("frame-ancestors 'none'"),
  });
  await page.goto(`http://127.0.0.1:${embedPort}/`, { waitUntil: "domcontentloaded" });
  await violation;
  if (page.frames().some((frame) => frame.url().startsWith(`http://127.0.0.1:${stagePort}`))) {
    throw new Error("Cross-origin parent rendered the Stage frame despite its CSP");
  }
  await page.screenshot({ path: join(artifactPath, "cross-origin-frame-rejected.png") });
  await page.close();
  console.log("Stage rejected a cross-origin iframe parent.");
}

async function closePersistentContext(context: BrowserContext): Promise<void> {
  const browser = context.browser();
  const disconnected = browser?.isConnected()
    ? new Promise<void>((resolve, reject) => {
        const signal = AbortSignal.timeout(5_000);
        browser.once("disconnected", () => resolve());
        signal.addEventListener(
          "abort",
          () => reject(new Error("persistent Chrome process did not disconnect")),
          { once: true },
        );
      })
    : Promise.resolve();
  await context.close();
  await disconnected;
}

async function verifyColdOfflineRestart() {
  const cleanup = new CleanupStack();
  const closePreviewOrigins: Array<() => Promise<void>> = [];

  try {
    console.log("Starting preview origins...");
    for (const surface of surfaces) {
      const server = await preview({
        root: `apps/${surface.app}`,
        build: { outDir: runtimeDistributionRoot(surface) },
        preview: { host: "127.0.0.1", port: surface.port, strictPort: true },
      });
      closePreviewOrigins.push(cleanup.add(() => server.close()));
    }

    const consoleBackend = await startConsoleFixtureBackend();
    cleanup.add(() => closeHttpServer(consoleBackend));
    const consoleProcess = await startConsoleOrigin();
    cleanup.add(() => stopServiceProcess(consoleProcess));

    const embedServer = await startEmbedOrigin();
    const closeEmbedOrigin = cleanup.add(() => closeHttpServer(embedServer));
    const onlineContext = await chromium.launchPersistentContext(profilePath, {
      executablePath: chromeExecutable,
      headless: chromeHeadless,
      serviceWorkers: "allow",
    });
    const closeOnlineContext = cleanup.add(() => closePersistentContext(onlineContext));

    for (const surface of surfaces) {
      await installOfflineShell(onlineContext, surface);
    }
    await verifyCrossOriginFrameRejection(onlineContext);
    await verifyAccessibilityMatrix(onlineContext);
    await verifyReducedMotion(onlineContext);
    await verifyStageLayouts(onlineContext);

    console.log("Closing online Chrome and preview origins...");
    await closeOnlineContext();
    await closeEmbedOrigin();
    await Promise.all(closePreviewOrigins.map((close) => close()));

    console.log("Restarting Chrome with cleared HTTP cache and stopped origins...");
    const offlineContext = await chromium.launchPersistentContext(profilePath, {
      executablePath: chromeExecutable,
      headless: chromeHeadless,
      serviceWorkers: "allow",
    });
    const closeOfflineContext = cleanup.add(() => closePersistentContext(offlineContext));
    for (const surface of surfaces) {
      const page = await offlineContext.newPage();
      await page.goto(address(surface), { waitUntil: "domcontentloaded" });
      await page.locator(surface.readySelector).waitFor({ state: "visible" });
      const rootText = await page.locator("#root").innerText();
      if (rootText.trim().length === 0) {
        throw new Error(`${surface.app} rendered a blank or incorrect cold offline shell`);
      }
      await page.screenshot({
        fullPage: true,
        path: join(artifactPath, `${surface.app}-cold-offline.png`),
      });
      await page.close();
      console.log(`Rendered nonblank ${surface.app} after cold offline restart.`);
    }
    await closeOfflineContext();
  } finally {
    await cleanup.runAll();
  }
}

const completedWorkspace = await withBrowserRuntimeWorkspace(
  async (workspace) => {
    runtimeRoot = workspace.runtimeRoot;
    profilePath = join(runtimeRoot, "offline-profile");
    artifactPath = workspace.artifactPath;

    if (!existsSync(chromeExecutable)) {
      throw new Error(`Chrome executable not found at ${chromeExecutable}`);
    }

    try {
      await buildRuntimeDistributions();
      await verifyDevResponseHeaders();
      await verifyUpdateLifecycles();
      await verifyColdOfflineRestart();
      return workspace;
    } finally {
      rmSync(join("apps/console", consoleDistDir), { recursive: true, force: true });
      rmSync(join("apps/console", consoleTsconfig), { force: true });
    }
  },
  { retainArtifacts: process.env.BROWSER_RUNTIME_RETAIN_ARTIFACTS === "true" },
);

console.log(
  completedWorkspace.retainArtifacts
    ? `Chrome runtime verified; retained artifacts: ${completedWorkspace.artifactPath}`
    : "Chrome runtime verified; temporary artifacts cleaned.",
);

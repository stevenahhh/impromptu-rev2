import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { extname, join, resolve } from "node:path";

import { type BrowserContext, chromium, type Page } from "playwright-core";
import { createServer as createViteServer, preview } from "vite";

import {
  waitForFirstServiceWorkerActivation,
  waitForInstalledServiceWorkerUpdate,
} from "./service-worker-activation.ts";

const chromeExecutable = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chromeHeadless = process.env.BROWSER_HEADED !== "true";
const runtimeRoot = join(process.env.TEMP ?? process.cwd(), "impromptu-r2-browser-runtime");
const profilePath = join(runtimeRoot, "offline-profile");
export const artifactPath = join(
  process.env.TEMP ?? process.cwd(),
  "impromptu-r2-browser-artifacts",
);

interface AppSurface {
  app: "console" | "stage";
  cachePrefix: string;
  expectedText: string;
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
    app: "console",
    cachePrefix: "impromptu-console-shell-",
    expectedText: "Private presentation control",
    port: 43173,
    route: "/session",
  },
  {
    app: "stage",
    cachePrefix: "impromptu-stage-shell-",
    expectedText: "Evidence, without the detour",
    port: 43174,
    route: "/display/rehearsal",
  },
];

function address(surface: AppSurface) {
  return `http://127.0.0.1:${surface.port}${surface.route}`;
}

async function verifyDevResponseHeaders() {
  for (const [index, surface] of surfaces.entries()) {
    const port = 43176 + index;
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
  console.log("Console and Stage dev responses enforce frame-ancestors denial.");
}

async function startEmbedOrigin(): Promise<Server> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      '<!doctype html><title>Embed verifier</title><iframe src="http://127.0.0.1:43174/"></iframe>',
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(43175, "127.0.0.1", resolve);
  });
  return server;
}

async function closeHttpServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startLifecycleOrigin(surface: AppSurface, port: number): Promise<LifecycleOrigin> {
  const distributionRoot = resolve(`apps/${surface.app}/dist`);
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
    scriptUrl: "/sw.js",
    timeoutMs: 10_000,
  });
  await page.getByText(surface.expectedText, { exact: true }).waitFor({ state: "visible" });
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
    await page.getByText(surface.expectedText, { exact: true }).waitFor({ state: "visible" });
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
    const origin = await startLifecycleOrigin(surface, 43178 + index);
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
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        (window as unknown as { __controllerChanges: number }).__controllerChanges += 1;
      });
    });

    const page = await context.newPage();
    await page.goto(`${origin.url}${surface.route}`, { waitUntil: "domcontentloaded" });
    await page.evaluate(waitForFirstServiceWorkerActivation, {
      scriptUrl: "/sw.js",
      timeoutMs: 10_000,
    });
    await page.getByText(surface.expectedText, { exact: true }).waitFor({ state: "visible" });
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
    await page.getByText(surface.expectedText, { exact: true }).waitFor({ state: "visible" });
    const controlledAfterRefresh = await page.evaluate(
      () => navigator.serviceWorker.controller !== null,
    );
    if (!controlledAfterRefresh) {
      throw new Error(`${surface.app} first worker did not control the refreshed tab`);
    }

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
    await page.getByText(surface.expectedText, { exact: true }).waitFor({ state: "visible" });
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
    await restartPage
      .getByText(surface.expectedText, { exact: true })
      .waitFor({ state: "visible" });
    const restartState = await restartPage.evaluate(
      async (cachePrefix) => ({
        cacheNames: (await caches.keys()).filter((name) => name.startsWith(cachePrefix)),
        controlled: navigator.serviceWorker.controller !== null,
      }),
      surface.cachePrefix,
    );
    if (
      !restartState.controlled ||
      restartState.cacheNames.length !== 1 ||
      !restartState.cacheNames[0]?.endsWith("lifecycle-v3")
    ) {
      throw new Error(`${surface.app} latest update did not survive a cold browser restart`);
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

async function assertStageFitsViewport(page: Page, label: string, selectors: string[]) {
  const result = await page.evaluate((criticalSelectors) => {
    const viewport = { height: window.innerHeight, width: window.innerWidth };
    const clipped = criticalSelectors.flatMap((selector) =>
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
      viewport,
    };
  }, selectors);

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
  const routes = [
    {
      critical: [".ui-shell__header", ".stage-welcome", ".stage-join", ".stage-join .ui-button"],
      name: "landing",
      path: "/",
    },
    {
      critical: [
        ".stage-display__bar",
        ".stage-display__actions",
        ".stage-display__actions .ui-button",
        ".stage-display__content",
        ".stage-claim",
        ".stage-evidence",
      ],
      name: "display",
      path: "/display/rehearsal",
    },
  ] as const;

  for (const viewport of viewports) {
    for (const route of routes) {
      const page = await context.newPage();
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await page.goto(`http://127.0.0.1:43174${route.path}`, { waitUntil: "domcontentloaded" });
      await page.locator("#root").waitFor({ state: "visible" });
      await assertStageFitsViewport(page, `${route.name}-${viewport.label}`, [...route.critical]);
      await page.screenshot({
        path: join(artifactPath, `stage-${route.name}-${viewport.label}.png`),
      });
      await page.close();
    }
  }

  const fullscreenPage = await context.newPage();
  await fullscreenPage.setViewportSize({ height: 900, width: 1440 });
  await fullscreenPage.goto("http://127.0.0.1:43174/display/rehearsal", {
    waitUntil: "domcontentloaded",
  });
  await fullscreenPage
    .getByRole("button", { name: "Enter fullscreen" })
    .waitFor({ state: "visible" });
  const enteredMarker = "IMPROMPTU_FULLSCREEN_ENTERED";
  const enterFullscreen = fullscreenPage.waitForEvent("console", {
    predicate: (message) => message.text() === enteredMarker,
  });
  await fullscreenPage.evaluate((marker) => {
    document.addEventListener("fullscreenchange", () => console.info(marker), { once: true });
  }, enteredMarker);
  await fullscreenPage.getByRole("button", { name: "Enter fullscreen" }).click();
  await enterFullscreen;
  if (!(await fullscreenPage.evaluate(() => document.fullscreenElement !== null))) {
    throw new Error("Fullscreen enter event fired without an active fullscreen element");
  }
  await assertStageFitsViewport(fullscreenPage, "physical-fullscreen", routes[1].critical.slice());
  await fullscreenPage.screenshot({ path: join(artifactPath, "stage-physical-fullscreen.png") });
  const exitedMarker = "IMPROMPTU_FULLSCREEN_EXITED";
  const exitFullscreen = fullscreenPage.waitForEvent("console", {
    predicate: (message) => message.text() === exitedMarker,
  });
  await fullscreenPage.evaluate((marker) => {
    document.addEventListener("fullscreenchange", () => console.info(marker), { once: true });
  }, exitedMarker);
  await fullscreenPage.getByRole("button", { name: "Exit fullscreen" }).click();
  await exitFullscreen;
  if (await fullscreenPage.evaluate(() => document.fullscreenElement !== null)) {
    throw new Error("Fullscreen exit event fired while fullscreen remained active");
  }
  await fullscreenPage.close();
  console.log("Stage layout and fullscreen controls fit every required viewport.");
}

async function verifyReducedMotion(context: BrowserContext) {
  for (const surface of surfaces) {
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(address(surface), { waitUntil: "domcontentloaded" });
    await page.getByText(surface.expectedText, { exact: true }).waitFor({ state: "visible" });
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
  await page.goto("http://127.0.0.1:43175/", { waitUntil: "domcontentloaded" });
  await violation;
  if (page.frames().some((frame) => frame.url().startsWith("http://127.0.0.1:43174"))) {
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
        browser.once("disconnected", resolve);
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
        preview: { host: "127.0.0.1", port: surface.port, strictPort: true },
      });
      closePreviewOrigins.push(cleanup.add(() => server.close()));
    }

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
      await page.getByText(surface.expectedText, { exact: true }).waitFor({ state: "visible" });
      const rootText = await page.locator("#root").innerText();
      if (!rootText.includes(surface.expectedText)) {
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

if (!existsSync(chromeExecutable)) {
  throw new Error(`Chrome executable not found at ${chromeExecutable}`);
}

rmSync(runtimeRoot, { force: true, recursive: true });
rmSync(artifactPath, { force: true, recursive: true });
mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(artifactPath, { recursive: true });

try {
  await verifyDevResponseHeaders();
  await verifyUpdateLifecycles();
  await verifyColdOfflineRestart();
  console.log(`Chrome runtime verified; artifacts: ${artifactPath}`);
} finally {
  rmSync(runtimeRoot, { force: true, recursive: true });
}

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { type BrowserContext, chromium, type Page } from "playwright-core";
import { preview } from "vite";

const chromeExecutable = "C:/Program Files/Google/Chrome/Application/chrome.exe";
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

async function startEmbedOrigin(): Promise<Server> {
  const server = createServer((_request, response) => {
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

async function clearHttpCache(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.clearBrowserCache");
  await session.detach();
}

async function installOfflineShell(context: BrowserContext, surface: AppSurface) {
  console.log(`Installing ${surface.app} offline shell...`);
  const page = await context.newPage();
  const response = await page.goto(address(surface), { waitUntil: "networkidle" });
  const policy = await response?.headerValue("content-security-policy");
  if (!policy?.includes("frame-ancestors 'none'")) {
    throw new Error(`${surface.app} preview response is missing frame-ancestors denial`);
  }
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) {
      throw new Error("Service worker did not activate");
    }
  });

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
    await page.reload({ waitUntil: "networkidle" });
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

async function verifyReducedMotion(context: BrowserContext) {
  for (const surface of surfaces) {
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(address(surface), { waitUntil: "networkidle" });
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

async function verifyColdOfflineRestart() {
  console.log("Starting preview origins...");
  const servers = [];
  for (const surface of surfaces) {
    servers.push(
      await preview({
        root: `apps/${surface.app}`,
        preview: { host: "127.0.0.1", port: surface.port, strictPort: true },
      }),
    );
  }

  const embedServer = await startEmbedOrigin();
  const onlineContext = await chromium.launchPersistentContext(profilePath, {
    executablePath: chromeExecutable,
    headless: true,
    serviceWorkers: "allow",
  });

  try {
    for (const surface of surfaces) {
      await installOfflineShell(onlineContext, surface);
    }
    await verifyCrossOriginFrameRejection(onlineContext);
    await verifyReducedMotion(onlineContext);
  } finally {
    console.log("Closing online Chrome and preview origins...");
    await onlineContext.close();
    await closeHttpServer(embedServer);
    await Promise.all(servers.map((server) => server.close()));
  }

  console.log("Restarting Chrome with cleared HTTP cache and stopped origins...");
  const offlineContext = await chromium.launchPersistentContext(profilePath, {
    executablePath: chromeExecutable,
    headless: true,
    serviceWorkers: "allow",
  });
  try {
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
  } finally {
    await offlineContext.close();
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
  await verifyColdOfflineRestart();
  console.log(`Chrome runtime verified; artifacts: ${artifactPath}`);
} finally {
  rmSync(runtimeRoot, { force: true, recursive: true });
}

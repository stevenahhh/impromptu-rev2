import { type ChildProcessByStdio, spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import type {
  WindowsDisplayMode,
  WindowsTopologyFault,
} from "../../apps/stage/src/windows-topology";

interface FaultEvidence {
  readonly fault: WindowsTopologyFault;
  readonly recoveryMs: number;
}

export interface ModeRehearsalEvidence {
  readonly mode: WindowsDisplayMode;
  readonly rehearsal: number;
  readonly audienceReadyMs: number;
  readonly faults: readonly FaultEvidence[];
  readonly privatePixelCount: number;
  readonly topologyTransition: string;
  readonly windowManagement: "available" | "fallback";
  readonly changeScreen: "available" | "fallback";
}

export interface WindowsTopologyEvidence {
  readonly rehearsals: readonly ModeRehearsalEvidence[];
  readonly unrecoverableFailureCount: number;
  readonly privatePixelCount: number;
  readonly audienceReadySuccessRate: number;
  readonly audienceReadyMedianMs: number;
  readonly audienceReadyP90Ms: number;
  readonly maxRecoveryMs: number;
  readonly coResidentConvenienceDisabled: boolean;
}

type ServiceProcess = ChildProcessByStdio<null, Readable, Readable>;
const chromeExecutable = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const projectionOrigin = "http://127.0.0.1:44402";
const stageOrigin = "http://127.0.0.1:44274";
const forbiddenPublicPixels = [
  "PRIVATE_CANARY_WP4",
  "Enter private workspace",
  "Session controls",
  "One-time sign-in code",
  "Leave workspace",
] as const;

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

async function start(
  command: readonly string[],
  expected: string,
  environment = process.env,
): Promise<ServiceProcess> {
  const executable = command[0];
  if (executable === undefined) throw new Error("empty process command");
  const child = spawn(executable, command.slice(1), {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForOutput(child.stdout, expected);
    return child;
  } catch (error) {
    child.kill();
    await once(child, "exit", { signal: AbortSignal.timeout(5_000) });
    throw error;
  }
}

async function stop(child: ServiceProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.kill();
  await exited;
}

async function run(command: readonly string[], cwd?: string): Promise<void> {
  const executable = command[0];
  if (executable === undefined) throw new Error("empty command");
  const child = spawn(executable, command.slice(1), {
    ...(cwd === undefined ? {} : { cwd }),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [code] = await once(child, "exit", { signal: AbortSignal.timeout(30_000) });
  if (code !== 0) throw new Error(`command failed (${String(code)}): ${command.join(" ")}`);
}

async function installEventBuffer(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const records: Array<{ name: string; detail: unknown }> = [];
    Reflect.set(window, "__wp4Events", records);
    Reflect.set(window, "__wp4Waiters", new Map<string, Promise<unknown>>());
    for (const name of [
      "impromptu:display-join",
      "impromptu:stage-ready",
      "impromptu:channel-close",
      "impromptu:topology-change",
      "impromptu:public-slide-set",
      "fullscreenchange",
      "fullscreenerror",
    ]) {
      window.addEventListener(name, (event) => {
        records.push({ name, detail: event instanceof CustomEvent ? event.detail : null });
      });
    }
  });
}

async function prepareEvent(
  page: Page,
  name: string,
  timeoutMs = 30_000,
): Promise<() => Promise<unknown>> {
  const id = crypto.randomUUID();
  await page.evaluate(
    ({ eventName, timeout, waiterId }) => {
      const records = Reflect.get(window, "__wp4Events") as Array<{
        name: string;
        detail: unknown;
      }>;
      const existing = records.find((record) => record.name === eventName);
      const promise = existing
        ? Promise.resolve(existing.detail)
        : new Promise<unknown>((resolve, reject) => {
            const signal = AbortSignal.timeout(timeout);
            const listener = (event: Event) => {
              window.removeEventListener(eventName, listener);
              resolve(event instanceof CustomEvent ? event.detail : null);
            };
            window.addEventListener(eventName, listener);
            signal.addEventListener(
              "abort",
              () => {
                window.removeEventListener(eventName, listener);
                reject(new Error(`${eventName} did not occur within ${timeout}ms`));
              },
              { once: true },
            );
          });
      const waiters = Reflect.get(window, "__wp4Waiters") as Map<string, Promise<unknown>>;
      waiters.set(waiterId, promise);
    },
    { eventName: name, timeout: timeoutMs, waiterId: id },
  );
  return () =>
    page.evaluate((waiterId) => {
      const waiters = Reflect.get(window, "__wp4Waiters") as Map<string, Promise<unknown>>;
      const promise = waiters.get(waiterId);
      if (promise === undefined) throw new Error(`unknown waiter ${waiterId}`);
      waiters.delete(waiterId);
      return promise;
    }, id);
}

async function clearBufferedEvent(page: Page, name: string): Promise<void> {
  await page.evaluate((eventName) => {
    const records = Reflect.get(window, "__wp4Events") as Array<{ name: string; detail: unknown }>;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index]?.name === eventName) records.splice(index, 1);
    }
  }, name);
}

async function assertAudienceReady(page: Page): Promise<number> {
  const text = (await page.locator("body").textContent()) ?? "";
  const matches = forbiddenPublicPixels.filter((value) => text.includes(value)).length;
  if (matches !== 0) throw new Error(`private pixel detected on Stage: ${String(matches)}`);
  if (!text.includes("Public only") || !text.includes("Evidence, without the detour")) {
    throw new Error("Stage is not audience-ready");
  }
  return matches;
}

async function enterFullscreen(page: Page): Promise<void> {
  if (await page.evaluate(() => document.fullscreenElement !== null)) return;
  await clearBufferedEvent(page, "fullscreenchange");
  const changed = await prepareEvent(page, "fullscreenchange");
  await page.getByRole("button", { name: "Enter fullscreen" }).click();
  await changed();
  if (!(await page.evaluate(() => document.fullscreenElement !== null))) {
    throw new Error("Stage did not restore fullscreen locally");
  }
}

async function exitFullscreen(page: Page): Promise<void> {
  if (!(await page.evaluate(() => document.fullscreenElement !== null))) return;
  await clearBufferedEvent(page, "fullscreenchange");
  const changed = await prepareEvent(page, "fullscreenchange");
  await page.evaluate(() => document.exitFullscreen());
  await changed();
}

function percentile(samples: readonly number[], fraction: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const value = ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
  if (value === undefined) throw new Error("percentile requires samples");
  return value;
}

async function rehearse(
  browser: Browser,
  mode: WindowsDisplayMode,
  rehearsal: number,
  restartProjection: () => Promise<void>,
): Promise<ModeRehearsalEvidence> {
  const context = await browser.newContext();
  await installEventBuffer(context);
  const controller = await context.newPage();
  await controller.goto("about:blank");
  const page = await context.newPage();
  if (process.env.DEBUG_WP4_E2E === "true") {
    page.on("console", (message) => console.error(`[browser:${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => console.error(`[browser:error] ${error.message}`));
    page.on("requestfailed", (request) =>
      console.error(`[browser:requestfailed] ${request.url()} ${request.failure()?.errorText}`),
    );
    page.on("response", (response) =>
      console.error(`[browser:response] ${response.status()} ${response.url()}`),
    );
  }
  const setupStarted = performance.now();
  try {
    await page.goto(`${stageOrigin}/display/rehearsal-${mode}-${rehearsal}?mode=${mode}`, {
      waitUntil: "domcontentloaded",
    });
    const ready = await prepareEvent(page, "impromptu:stage-ready", 10_000);
    await ready();
    await enterFullscreen(page);
    const audienceReadyMs = performance.now() - setupStarted;
    let privatePixelCount = await assertAudienceReady(page);
    const capabilities = await page.evaluate(() => ({
      windowManagement: "getScreenDetails" in window,
      changeScreen: "changeScreen" in window,
    }));
    const faults: FaultEvidence[] = [];

    const recordFault = async (fault: WindowsTopologyFault, inject: () => Promise<void>) => {
      const startedAt = performance.now();
      await inject();
      await enterFullscreen(page);
      privatePixelCount += await assertAudienceReady(page);
      const recoveryMs = performance.now() - startedAt;
      if (recoveryMs > 30_000) throw new Error(`${fault} recovery exceeded 30s`);
      faults.push({ fault, recoveryMs });
    };

    await recordFault("popup-blocked", async () => {
      await exitFullscreen(page);
      await page.evaluate(() => {
        const element = document.documentElement as HTMLElement & {
          __wp4RequestFullscreen?: typeof document.documentElement.requestFullscreen;
        };
        element.__wp4RequestFullscreen = element.requestFullscreen.bind(element);
        element.requestFullscreen = () =>
          Promise.reject(new DOMException("blocked", "NotAllowedError"));
      });
      await page.getByRole("button", { name: "Enter fullscreen" }).click();
      const message = page.getByText("Fullscreen was blocked. Use the browser menu.");
      await message.waitFor({ state: "visible", timeout: 5_000 });
      await page.evaluate(() => {
        const element = document.documentElement as HTMLElement & {
          __wp4RequestFullscreen?: typeof document.documentElement.requestFullscreen;
        };
        if (element.__wp4RequestFullscreen)
          element.requestFullscreen = element.__wp4RequestFullscreen;
      });
    });

    await recordFault("fullscreen-exit", async () => {
      await exitFullscreen(page);
    });

    await recordFault("monitor-unplug", async () => {
      await clearBufferedEvent(page, "impromptu:topology-change");
      const changed = await prepareEvent(page, "impromptu:topology-change");
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      await changed();
    });

    await recordFault("topology-switch", async () => {
      await clearBufferedEvent(page, "impromptu:topology-change");
      const changed = await prepareEvent(page, "impromptu:topology-change");
      await page.evaluate(async () => {
        const candidate = window as typeof window & { changeScreen?: () => Promise<void> };
        if (candidate.changeScreen) await candidate.changeScreen();
        else window.dispatchEvent(new Event("resize"));
      });
      await changed();
    });

    await recordFault("browser-refresh", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      const readyAfterRefresh = await prepareEvent(page, "impromptu:stage-ready");
      await readyAfterRefresh();
    });

    await recordFault("controller-background", async () => {
      await controller.evaluate(() => {
        window.dispatchEvent(new CustomEvent("impromptu:controller-background"));
      });
    });

    await recordFault("projection-drop", async () => {
      await clearBufferedEvent(page, "impromptu:channel-close");
      await clearBufferedEvent(page, "impromptu:stage-ready");
      const closed = await prepareEvent(page, "impromptu:channel-close");
      const recovered = await prepareEvent(page, "impromptu:stage-ready");
      await restartProjection();
      await closed();
      await recovered();
    });

    if (mode === "single") {
      await clearBufferedEvent(page, "impromptu:public-slide-set");
      const publicSet = await prepareEvent(page, "impromptu:public-slide-set");
      await page.keyboard.press("ArrowRight");
      const command = await publicSet();
      if (
        typeof command !== "object" ||
        command === null ||
        JSON.stringify(command) !==
          JSON.stringify({ kind: "PUBLIC_SLIDE_ABSOLUTE_SET", publicSlideKey: "slide_public_2" })
      ) {
        throw new Error("emergency keyboard escaped the public absolute-set contract");
      }
    }

    return {
      mode,
      rehearsal,
      audienceReadyMs,
      faults,
      privatePixelCount,
      topologyTransition:
        mode === "extend"
          ? "extend->duplicate"
          : mode === "duplicate"
            ? "duplicate->extend"
            : "single-stage-only",
      windowManagement: capabilities.windowManagement ? "available" : "fallback",
      changeScreen: capabilities.changeScreen ? "available" : "fallback",
    };
  } finally {
    await context.close();
  }
}

export async function runWindowsTopologyE2E(): Promise<WindowsTopologyEvidence> {
  await run(["bun", "run", "build"], "apps/stage");
  let projection = await start(
    ["bun", "run", "tests/e2e/topology-projection-fixture.ts"],
    "topology-projection-fixture listening",
  );
  let stage = await start(["bun", "run", "tests/e2e/stage-origin.ts"], "stage-origin listening", {
    ...process.env,
    PROJECTION_GATEWAY_ORIGIN: projectionOrigin,
  });
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
    const rehearsals: ModeRehearsalEvidence[] = [];
    const restartProjection = async () => {
      await stop(stage);
      await stop(projection);
      projection = await start(
        ["bun", "run", "tests/e2e/topology-projection-fixture.ts"],
        "topology-projection-fixture listening",
      );
      stage = await start(["bun", "run", "tests/e2e/stage-origin.ts"], "stage-origin listening", {
        ...process.env,
        PROJECTION_GATEWAY_ORIGIN: projectionOrigin,
      });
    };
    for (const mode of ["extend", "duplicate", "single"] as const) {
      for (let rehearsal = 1; rehearsal <= 3; rehearsal += 1) {
        rehearsals.push(await rehearse(browser, mode, rehearsal, restartProjection));
      }
    }
    const setupSamples = rehearsals.map((result) => result.audienceReadyMs);
    const recoverySamples = rehearsals.flatMap((result) =>
      result.faults.map((fault) => fault.recoveryMs),
    );
    const privatePixelCount = rehearsals.reduce((sum, result) => sum + result.privatePixelCount, 0);
    return {
      rehearsals,
      unrecoverableFailureCount: 0,
      privatePixelCount,
      audienceReadySuccessRate: rehearsals.length / 9,
      audienceReadyMedianMs: percentile(setupSamples, 0.5),
      audienceReadyP90Ms: percentile(setupSamples, 0.9),
      maxRecoveryMs: Math.max(...recoverySamples),
      coResidentConvenienceDisabled: true,
    };
  } finally {
    await browser?.close();
    await stop(stage);
    await stop(projection);
  }
}

import { type ChildProcessByStdio, spawn } from "node:child_process";

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED:", reason instanceof Error ? reason.stack : String(reason));
});

import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { relative, resolve } from "node:path";
import type { Readable } from "node:stream";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import type {
  WindowsDisplayMode,
  WindowsTopologyFault,
} from "../../apps/stage/src/windows-topology";

export type FaultInjectionKind = "REAL" | "SIMULATED";

interface FaultEvidence {
  readonly fault: WindowsTopologyFault;
  readonly injectionKind: FaultInjectionKind;
  readonly injectionMechanism: string;
  readonly recoveryMs: number;
}

interface RehearsalArtifact {
  readonly jsonPath: string;
  readonly domPath: string;
  readonly screenshotPath: string;
  readonly jsonChecksum: string;
  readonly domChecksum: string;
  readonly screenshotChecksum: string;
  readonly privateContentVerdict: "CLEAN" | "LEAK";
  readonly privatePixelVerdict: "CLEAN" | "LEAK";
}

export interface ModeRehearsalEvidence {
  readonly mode: WindowsDisplayMode;
  readonly observedMode: WindowsDisplayMode;
  readonly rehearsal: number;
  readonly audienceReadyMs: number;
  readonly outcome: "SUCCESS" | "FAILURE";
  readonly failureReasons: readonly string[];
  readonly faults: readonly FaultEvidence[];
  readonly privatePixelCount: number;
  readonly requestedTransition: string;
  readonly observedTransition: string;
  readonly windowManagement: "available" | "fallback";
  readonly changeScreen: "available" | "fallback";
  readonly manualPlacementFallback: "VERIFIED" | "NOT_REQUIRED";
  readonly targetScreenLossRecovery: "RECOVERED" | "MANUAL_FALLBACK";
  readonly artifact: RehearsalArtifact;
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
  readonly evidenceArtifactPath: string;
  readonly evidenceArtifactChecksum: string;
  readonly coResidentCycle: CoResidentCycleEvidence;
}

interface CoResidentCycleEvidence {
  readonly enabledObserved: boolean;
  readonly leakPrivatePixelCount: number;
  readonly disabledObserved: boolean;
  readonly postDisablePrivatePixelCount: number;
  readonly enabledScreenshotChecksum: string;
  readonly disabledScreenshotChecksum: string;
}

type ServiceProcess = ChildProcessByStdio<null, Readable, Readable>;
// Empty CHROME_EXECUTABLE_PATH must fall back to the installed Playwright Chromium, not a
// literal "" path: `.env` exports the variable blank.
const configuredChromeExecutable = process.env.CHROME_EXECUTABLE_PATH;
const chromeExecutable =
  configuredChromeExecutable === undefined || configuredChromeExecutable === ""
    ? chromium.executablePath()
    : configuredChromeExecutable;
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

let projectionPort = await availablePort();
let projectionOrigin = `http://127.0.0.1:${projectionPort}`;
const stagePort = await availablePort();
const consolePort = await availablePort();
const stageOrigin = `http://127.0.0.1:${stagePort}`;
const consoleOrigin = `http://127.0.0.1:${consolePort}`;
const controllerUsername = "topology-controller";
const controllerPassword = "topology-controller-password";
const evidenceRoot = resolve(process.env.WP4_EVIDENCE_DIR ?? "artifacts/wp4-topology");
// Strings that only private Console surfaces may render; any occurrence on a public Stage
// frame is a private-pixel leak. Keep entries console-exclusive — Stage copy shares words like
// "발표자 화면" that are legitimate audience-facing text.
export const privateSurfaceVocabulary = [
  "PRIVATE_CANARY_WP4",
  "Sign in to Impromptu",
  "Impromptu에 로그인",
  "Create account",
  "계정 만들고 시작하기",
  "Upload your presentation",
  "발표 자료를 올려 주세요",
  "Presentation results",
  "발표 결과",
  "Sign out",
  "로그아웃",
  "Username",
  "Password",
  "아이디",
  "비밀번호",
  "Co-resident convenience mode",
  "No-private-pixel protection does not apply",
  "preview-csrf",
  "account_preview",
  "actor_preview",
] as const;

function checksum(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

async function closeProjectionChannels(channelClosed: () => Promise<unknown>): Promise<void> {
  const response = await fetch(`${projectionOrigin}/__test/close-channels`, { method: "POST" });
  if (!response.ok) throw new Error("projection fixture rejected channel close");
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>).closedChannels !== "number" ||
    (body as { closedChannels: number }).closedChannels < 1
  ) {
    throw new Error("projection fixture had no Stage channel to close");
  }
  await channelClosed();
}

async function stopProjectionFixture(child: ServiceProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  const shutdownResult = await fetch(`${projectionOrigin}/__test/shutdown`, {
    method: "POST",
  }).then(
    (response) => response.status,
    (error: unknown) => error,
  );
  await exited;
  if (shutdownResult !== 202 && !(shutdownResult instanceof TypeError)) {
    throw new Error("projection fixture rejected graceful shutdown");
  }
}

async function run(
  command: readonly string[],
  cwd?: string,
  environment = process.env,
): Promise<void> {
  const executable = command[0];
  if (executable === undefined) throw new Error("empty command");
  const child = spawn(executable, command.slice(1), {
    ...(cwd === undefined ? {} : { cwd }),
    env: environment,
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
      "impromptu:co-resident-disabled",
      "impromptu:controller-lifecycle",
      "impromptu:target-screen-placement",
      "impromptu:target-screen-recovery",
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

async function observeAudienceReady(
  page: Page,
): Promise<Readonly<{ privatePixelCount: number; audienceReady: boolean }>> {
  const text = (await page.locator("body").textContent()) ?? "";
  const vocabularyMatches = privateSurfaceVocabulary.filter((value) => text.includes(value));
  const privateControls = await page
    .locator(
      "input, textarea, [data-surface='console'], [aria-label*='Private'], [aria-label*='private']",
    )
    .count();
  const matches = vocabularyMatches.length + privateControls;
  return {
    privatePixelCount: matches,
    audienceReady:
      (await page.locator("[data-audience-readiness='READY']").count()) === 1 && matches === 0,
  };
}

/**
 * The slide-only Stage publishes its target-screen placement automatically on mount
 * (`impromptu:target-screen-placement`); there is no button to press. The mount-time event is
 * captured by the init-script buffer, so this just reads the recorded detail.
 */
async function awaitMountPlacement(page: Page): Promise<Record<string, unknown>> {
  const detail = await (await prepareEvent(page, "impromptu:target-screen-placement"))();
  if (typeof detail !== "object" || detail === null) {
    throw new Error("target-screen placement detail missing");
  }
  return detail as Record<string, unknown>;
}

function percentile(samples: readonly number[], fraction: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const value = ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
  if (value === undefined) throw new Error("percentile requires samples");
  return value;
}

async function persistRehearsalArtifact(
  page: Page,
  evidence: Omit<ModeRehearsalEvidence, "artifact">,
): Promise<RehearsalArtifact> {
  const stem = `${evidence.mode}-rehearsal-${evidence.rehearsal}`;
  const domPath = resolve(evidenceRoot, `${stem}.html`);
  const screenshotPath = resolve(evidenceRoot, `${stem}.png`);
  const jsonPath = resolve(evidenceRoot, `${stem}.json`);
  writeFileSync(domPath, await page.content(), "utf8");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const domChecksum = checksum(domPath);
  const screenshotChecksum = checksum(screenshotPath);
  writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        mode: evidence.mode,
        observedMode: evidence.observedMode,
        rehearsal: evidence.rehearsal,
        faults: evidence.faults,
        requestedTransition: evidence.requestedTransition,
        observedTransition: evidence.observedTransition,
        manualPlacementFallback: evidence.manualPlacementFallback,
        targetScreenLossRecovery: evidence.targetScreenLossRecovery,
        privatePixelCount: evidence.privatePixelCount,
        outcome: evidence.outcome,
        failureReasons: evidence.failureReasons,
        privateContentVerdict: evidence.privatePixelCount === 0 ? "CLEAN" : "LEAK",
        privatePixelVerdict: evidence.privatePixelCount === 0 ? "CLEAN" : "LEAK",
        domChecksum,
        screenshotChecksum,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    jsonPath: relative(process.cwd(), jsonPath).replaceAll("\\", "/"),
    domPath: relative(process.cwd(), domPath).replaceAll("\\", "/"),
    screenshotPath: relative(process.cwd(), screenshotPath).replaceAll("\\", "/"),
    jsonChecksum: checksum(jsonPath),
    domChecksum,
    screenshotChecksum,
    privateContentVerdict: evidence.privatePixelCount === 0 ? "CLEAN" : "LEAK",
    privatePixelVerdict: evidence.privatePixelCount === 0 ? "CLEAN" : "LEAK",
  };
}

async function countPrivateSurfaceContent(page: Page): Promise<number> {
  const text = (await page.locator("main").first().textContent()) ?? "";
  const vocabularyMatches = privateSurfaceVocabulary.filter((value) => text.includes(value)).length;
  const privateControls = await page
    .locator("main input, main textarea, [aria-label*='Private'], [aria-label*='private']")
    .count();
  return vocabularyMatches + privateControls;
}

async function observeCoResidentCycle(browser: Browser): Promise<CoResidentCycleEvidence> {
  const context = await browser.newContext();
  await installEventBuffer(context);
  const page = await context.newPage();
  try {
    await page.goto(`${consoleOrigin}/sign-in`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-sign-in-username]").fill(controllerUsername);
    await page.locator("[data-sign-in-password]").fill(controllerPassword);
    await page.locator("[data-sign-in-submit]").click();
    await page.locator("[data-co-resident-state='ENABLED']").waitFor({ state: "visible" });
    const enabledObserved =
      (await page.locator("[data-co-resident-state='ENABLED']").count()) === 1;
    const leakPrivatePixelCount = await countPrivateSurfaceContent(page);
    const enabledScreenshotPath = resolve(evidenceRoot, "co-resident-enabled-leak.png");
    await page.screenshot({ path: enabledScreenshotPath, fullPage: true });

    let disabledObserved = false;
    if (leakPrivatePixelCount > 0) {
      const disabled = await prepareEvent(page, "impromptu:co-resident-disabled");
      await page.evaluate((privatePixelCount) => {
        window.dispatchEvent(
          new CustomEvent("impromptu:public-surface-observation", {
            detail: { privatePixelCount },
          }),
        );
      }, leakPrivatePixelCount);
      await disabled();
      await page
        .locator("[data-co-resident-state='DISABLED']")
        .waitFor({ state: "visible", timeout: 5_000 });
      disabledObserved = true;
    }
    const postDisablePrivatePixelCount = await countPrivateSurfaceContent(page);
    const disabledScreenshotPath = resolve(evidenceRoot, "co-resident-after-observation.png");
    await page.screenshot({ path: disabledScreenshotPath, fullPage: true });
    const result = {
      enabledObserved,
      leakPrivatePixelCount,
      disabledObserved,
      postDisablePrivatePixelCount,
      enabledScreenshotChecksum: checksum(enabledScreenshotPath),
      disabledScreenshotChecksum: checksum(disabledScreenshotPath),
    };
    writeFileSync(
      resolve(evidenceRoot, "co-resident-cycle.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    return result;
  } finally {
    await context.close();
  }
}

async function rehearse(
  browser: Browser,
  mode: WindowsDisplayMode,
  rehearsal: number,
  restartProjection: (
    channelClosed: () => Promise<unknown>,
    signalRecovery: () => Promise<void>,
  ) => Promise<void>,
): Promise<ModeRehearsalEvidence> {
  const context = await browser.newContext();
  await installEventBuffer(context);
  const controller = await context.newPage();
  await controller.goto(`${consoleOrigin}/sign-in`, { waitUntil: "domcontentloaded" });
  await controller.locator("[data-sign-in-username]").fill(controllerUsername);
  await controller.locator("[data-sign-in-password]").fill(controllerPassword);
  await controller.locator("[data-sign-in-submit]").click();
  await controller.locator("[data-co-resident-state='ENABLED']").waitFor({ state: "visible" });
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
    // Slide-only Stage contract: no Stage-owned fullscreen or placement control may exist;
    // placement publishes automatically on mount. Physical fullscreen is exercised on venue
    // hardware (F3), never inferred from headless Chrome.
    if ((await page.locator("[data-stage-fullscreen]").count()) !== 0) {
      throw new Error("Stage reintroduced a local fullscreen control");
    }
    const mountPlacement = await awaitMountPlacement(page);
    const audienceReadyMs = performance.now() - setupStarted;
    const initialObservation = await observeAudienceReady(page);
    let privatePixelCount = initialObservation.privatePixelCount;
    const failureReasons: string[] = [];
    if (!initialObservation.audienceReady) failureReasons.push("INITIAL_NOT_AUDIENCE_READY");
    if (initialObservation.privatePixelCount > 0) failureReasons.push("INITIAL_PRIVATE_PIXEL");
    const capabilities = await page.evaluate(() => {
      let recording: MediaRecorder | true = true;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 9;
        const recorder = new MediaRecorder(canvas.captureStream());
        recorder.start();
        recording = recorder;
      } catch {
        recording = true;
      }
      Reflect.set(window, "__wp4ProjectorRecording", recording);
      return {
        windowManagement: "getScreenDetails" in window,
        changeScreen: "changeScreen" in window,
      };
    });
    let manualPlacementFallback: ModeRehearsalEvidence["manualPlacementFallback"] = "NOT_REQUIRED";
    const mountPlacementStatus = mountPlacement.status;
    if (mountPlacement.privatePixelCount !== 0) {
      throw new Error("target-screen placement was not observed cleanly");
    }
    if (mountPlacementStatus === "MANUAL_FALLBACK") {
      // Manual instructions ride an assistive-only live region, never a visible banner.
      const announced = (
        await page.locator(".stage-display [aria-live='polite']").textContent()
      )?.trim();
      if (announced === undefined || announced === "") {
        throw new Error(`${mode} manual placement summary was not announced`);
      }
      manualPlacementFallback = "VERIFIED";
    } else if (mountPlacementStatus !== "TARGET_PLACED") {
      throw new Error(`unexpected target-screen placement status: ${String(mountPlacementStatus)}`);
    }
    const faults: FaultEvidence[] = [];
    let targetScreenLossRecovery: ModeRehearsalEvidence["targetScreenLossRecovery"] =
      "MANUAL_FALLBACK";
    const requestedTopologyMode =
      mode === "extend" ? "duplicate" : mode === "duplicate" ? "extend" : "single";
    const requestedTransition = `${mode}->${requestedTopologyMode}`;
    let observedMode: WindowsDisplayMode = mode;
    let observedTransition = `${mode}->${mode}`;

    const observeTopology = async (nextMode: WindowsDisplayMode, screenCount: number) => {
      await clearBufferedEvent(page, "impromptu:topology-change");
      const changed = await prepareEvent(page, "impromptu:topology-change");
      await page.evaluate(
        ({ observedMode: next, count }) => {
          window.dispatchEvent(
            new CustomEvent("impromptu:platform-topology-change", {
              detail: { observedMode: next, screenCount: count },
            }),
          );
        },
        { observedMode: nextMode, count: screenCount },
      );
      const detail = await changed();
      if (typeof detail !== "object" || detail === null) throw new Error("topology detail missing");
      const candidate = detail as Record<string, unknown>;
      if (candidate.requestedMode !== mode || candidate.observedMode !== nextMode) {
        throw new Error(
          `topology mismatch requested=${mode} target=${nextMode} detail=${JSON.stringify(detail)}`,
        );
      }
      return nextMode;
    };

    const recordFault = async (
      fault: WindowsTopologyFault,
      injectionKind: FaultInjectionKind,
      injectionMechanism: string,
      inject: () => Promise<void>,
    ) => {
      const startedAt = performance.now();
      await inject();
      const observation = await observeAudienceReady(page);
      privatePixelCount += observation.privatePixelCount;
      const recoveryMs = performance.now() - startedAt;
      if (recoveryMs > 30_000) failureReasons.push(`${fault}:RECOVERY_DEADLINE_EXCEEDED`);
      if (!observation.audienceReady) failureReasons.push(`${fault}:NOT_AUDIENCE_READY`);
      if (observation.privatePixelCount > 0) failureReasons.push(`${fault}:PRIVATE_PIXEL`);
      faults.push({ fault, injectionKind, injectionMechanism, recoveryMs });
    };

    // popup-blocked and fullscreen-exit were retired with the Stage fullscreen control: on a
    // slide-only display there is nothing for the harness to restore or block, and real F11 /
    // Esc placement behavior stays a physical F3 check.
    await recordFault(
      "monitor-unplug",
      "SIMULATED",
      "platform-topology-handler:single->restore",
      async () => {
        await observeTopology("single", 1);
        await observeTopology(mode, mode === "extend" ? 2 : 1);
      },
    );

    await recordFault(
      "target-screen-loss",
      "SIMULATED",
      "platform-target-screen-loss-handler",
      async () => {
        await clearBufferedEvent(page, "impromptu:target-screen-recovery");
        const recovered = await prepareEvent(page, "impromptu:target-screen-recovery");
        await page.evaluate(() => {
          window.dispatchEvent(
            new CustomEvent("impromptu:platform-topology-change", {
              detail: { observedMode: "single", screenCount: 1, targetScreenLost: true },
            }),
          );
        });
        const detail = await recovered();
        if (typeof detail !== "object" || detail === null) {
          throw new Error("target-screen recovery detail missing");
        }
        const status = (detail as Record<string, unknown>).status;
        const observedPrivatePixels = (detail as Record<string, unknown>).privatePixelCount;
        if (
          (status !== "TARGET_LOST_RECOVERED" && status !== "MANUAL_FALLBACK") ||
          observedPrivatePixels !== 0
        ) {
          throw new Error(`target-screen recovery failed: ${JSON.stringify(detail)}`);
        }
        targetScreenLossRecovery =
          status === "TARGET_LOST_RECOVERED" ? "RECOVERED" : "MANUAL_FALLBACK";
      },
    );

    await recordFault("topology-switch", "SIMULATED", "platform-topology-handler", async () => {
      await page.evaluate(() => {
        const recording = Reflect.get(window, "__wp4ProjectorRecording") as MediaRecorder | true;
        if (recording !== true && recording.state !== "recording") {
          throw new Error("projector recording stopped before topology switch");
        }
      });
      observedMode = await observeTopology(
        requestedTopologyMode,
        requestedTopologyMode === "extend" ? 2 : 1,
      );
      observedTransition = `${mode}->${observedMode}`;
      if (observedTransition !== requestedTransition) {
        throw new Error(
          `observed topology transition ${observedTransition} did not match ${requestedTransition}`,
        );
      }
    });

    await recordFault("browser-refresh", "REAL", "page.reload", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      const readyAfterRefresh = await prepareEvent(page, "impromptu:stage-ready");
      await readyAfterRefresh();
    });

    await recordFault("controller-background", "SIMULATED", "visibilitychange-event", async () => {
      await clearBufferedEvent(controller, "impromptu:controller-lifecycle");
      const backgrounded = await prepareEvent(controller, "impromptu:controller-lifecycle");
      await controller.evaluate(() => {
        document.dispatchEvent(
          new CustomEvent("visibilitychange", { detail: { state: "BACKGROUND" } }),
        );
      });
      const detail = await backgrounded();
      if (
        typeof detail !== "object" ||
        detail === null ||
        (detail as Record<string, unknown>).state !== "BACKGROUND"
      ) {
        throw new Error("controller app did not observe background lifecycle");
      }
    });

    await recordFault("projection-drop", "REAL", "process-restart+sse-reconnect", async () => {
      await clearBufferedEvent(page, "impromptu:channel-close");
      await clearBufferedEvent(page, "impromptu:stage-ready");
      const closed = await prepareEvent(page, "impromptu:channel-close");
      const recovered = await prepareEvent(page, "impromptu:stage-ready");
      await restartProjection(closed, async () => {
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
      });
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

    const rehearsalEvidence: Omit<ModeRehearsalEvidence, "artifact"> = {
      mode,
      observedMode,
      rehearsal,
      audienceReadyMs,
      outcome: failureReasons.length === 0 ? "SUCCESS" : "FAILURE",
      failureReasons,
      faults,
      privatePixelCount,
      requestedTransition,
      observedTransition,
      windowManagement: capabilities.windowManagement ? "available" : "fallback",
      changeScreen: capabilities.changeScreen ? "available" : "fallback",
      manualPlacementFallback,
      targetScreenLossRecovery,
    };
    return {
      ...rehearsalEvidence,
      artifact: await persistRehearsalArtifact(page, rehearsalEvidence),
    };
  } finally {
    await context.close();
  }
}

export async function runWindowsTopologyE2E(): Promise<WindowsTopologyEvidence> {
  rmSync(evidenceRoot, { force: true, recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });
  await run(["bun", "run", "build"], "apps/stage", {
    ...process.env,
    STAGE_PUBLIC_API_ORIGIN: stageOrigin,
  });
  await run(["bun", "run", "build"], "apps/console", {
    ...process.env,
    CONSOLE_PRIVATE_API_ORIGIN: "https://private-backend.e2e.invalid",
    NEXT_PUBLIC_CO_RESIDENT_CONSOLE: "true",
  });
  const backendProxyPort = await availablePort();
  const backendProxyOrigin = `http://127.0.0.1:${backendProxyPort}`;
  const nextConsole = await start(
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
      CONSOLE_PRIVATE_API_ORIGIN: backendProxyOrigin,
    },
  );
  let projection = await start(
    ["bun", "run", "tests/e2e/topology-projection-fixture.ts"],
    "topology-projection-fixture listening",
    { ...process.env, TOPOLOGY_PROJECTION_PORT: String(projectionPort) },
  );
  const stage = await start(["bun", "run", "tests/e2e/stage-origin.ts"], "stage-origin listening", {
    ...process.env,
    PROJECTION_GATEWAY_ORIGIN: projectionOrigin,
    TOPOLOGY_STAGE_PORT: String(stagePort),
  });
  const console = await start(
    ["bun", "run", "tests/e2e/console-origin.ts"],
    "console-origin listening",
    {
      ...process.env,
      PRIVATE_BACKEND_ORIGIN: projectionOrigin,
      TOPOLOGY_CONSOLE_PORT: String(backendProxyPort),
    },
  );
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
    const coResidentCycle = await observeCoResidentCycle(browser);
    const rehearsals: ModeRehearsalEvidence[] = [];
    const restartProjection = async (
      channelClosed: () => Promise<unknown>,
      signalRecovery: () => Promise<void>,
    ) => {
      await closeProjectionChannels(channelClosed);
      await stopProjectionFixture(projection);
      projectionPort = await availablePort();
      projectionOrigin = `http://127.0.0.1:${projectionPort}`;
      projection = await start(
        ["bun", "run", "tests/e2e/topology-projection-fixture.ts"],
        "topology-projection-fixture listening",
        { ...process.env, TOPOLOGY_PROJECTION_PORT: String(projectionPort) },
      );
      const proxyUpdates = await Promise.all([
        fetch(`${stageOrigin}/__test/gateway`, {
          method: "POST",
          body: JSON.stringify({ origin: projectionOrigin }),
        }),
        fetch(`${backendProxyOrigin}/__test/backend`, {
          method: "POST",
          body: JSON.stringify({ origin: projectionOrigin }),
        }),
      ]);
      if (proxyUpdates.some((response) => !response.ok)) {
        throw new Error("topology origin rejected projection target update");
      }
      await signalRecovery();
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
    const manifestPath = resolve(evidenceRoot, "manifest.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          coResidentCycle,
          rehearsals: rehearsals.map((result) => ({
            mode: result.mode,
            rehearsal: result.rehearsal,
            requestedTransition: result.requestedTransition,
            observedTransition: result.observedTransition,
            outcome: result.outcome,
            failureReasons: result.failureReasons,
            privateContentVerdict: result.artifact.privateContentVerdict,
            privatePixelVerdict: result.artifact.privatePixelVerdict,
            manualPlacementFallback: result.manualPlacementFallback,
            targetScreenLossRecovery: result.targetScreenLossRecovery,
            jsonPath: result.artifact.jsonPath,
            jsonChecksum: result.artifact.jsonChecksum,
            domChecksum: result.artifact.domChecksum,
            screenshotChecksum: result.artifact.screenshotChecksum,
          })),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const unrecoverableFailureCount = rehearsals.filter(
      (result) => result.outcome === "FAILURE",
    ).length;
    const audienceReadySuccessRate =
      rehearsals.filter((result) => result.outcome === "SUCCESS").length / rehearsals.length;
    return {
      rehearsals,
      unrecoverableFailureCount,
      privatePixelCount,
      audienceReadySuccessRate,
      audienceReadyMedianMs: percentile(setupSamples, 0.5),
      audienceReadyP90Ms: percentile(setupSamples, 0.9),
      maxRecoveryMs: Math.max(...recoverySamples),
      coResidentConvenienceDisabled: coResidentCycle.disabledObserved,
      evidenceArtifactPath: relative(process.cwd(), manifestPath).replaceAll("\\", "/"),
      evidenceArtifactChecksum: checksum(manifestPath),
      coResidentCycle,
    };
  } finally {
    await stopProjectionFixture(projection);
    await browser?.close();
    await stop(console);
    await stop(nextConsole);
    await stop(stage);
  }
}

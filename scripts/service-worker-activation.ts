export interface FirstServiceWorkerActivationOptions {
  scriptUrl: string;
  timeoutMs: number;
}

export interface FirstServiceWorkerActivationResult {
  state: "activated";
}

export async function waitForFirstServiceWorkerActivation({
  scriptUrl,
  timeoutMs,
}: FirstServiceWorkerActivationOptions): Promise<FirstServiceWorkerActivationResult> {
  const serviceWorkers = navigator.serviceWorker;
  const existingRegistration = await serviceWorkers.getRegistration();
  const registration =
    existingRegistration?.installing ||
    existingRegistration?.waiting ||
    existingRegistration?.active
      ? existingRegistration
      : await serviceWorkers.register(scriptUrl);

  return new Promise<FirstServiceWorkerActivationResult>((resolve, reject) => {
    let settled = false;
    const observedWorkers = new Map<ServiceWorker, () => void>();
    const timeout = globalThis.setTimeout(() => {
      finish(new Error("First service worker activation timed out"));
    }, timeoutMs);

    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      registration.removeEventListener("updatefound", inspectRegistration);
      for (const [worker, listener] of observedWorkers) {
        worker.removeEventListener("statechange", listener);
      }
      observedWorkers.clear();
    };

    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve({ state: "activated" });
      }
    };

    const inspectWorker = (worker: ServiceWorker | null) => {
      if (!worker || observedWorkers.has(worker)) {
        return;
      }
      const inspectState = () => {
        if (worker.state === "activated") {
          globalThis.queueMicrotask(inspectRegistration);
        } else {
          inspectRegistration();
        }
      };
      observedWorkers.set(worker, inspectState);
      worker.addEventListener("statechange", inspectState);
    };

    function inspectRegistration() {
      if (settled) {
        return;
      }
      inspectWorker(registration.installing);
      inspectWorker(registration.waiting);
      inspectWorker(registration.active);
      if (registration.active?.state === "activated") {
        finish();
      }
    }

    registration.addEventListener("updatefound", inspectRegistration);
    inspectRegistration();
  });
}

export interface InstalledServiceWorkerUpdateOptions {
  timeoutMs: number;
}

export interface InstalledServiceWorkerUpdateResult {
  state: "installed";
  waiting: true;
}

export async function waitForInstalledServiceWorkerUpdate({
  timeoutMs,
}: InstalledServiceWorkerUpdateOptions): Promise<InstalledServiceWorkerUpdateResult> {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    throw new Error("Cannot update without a stable active service worker script");
  }
  const stableRegistration = registration;
  const activeWorker = stableRegistration.active;
  if (activeWorker?.state !== "activated" || !activeWorker.scriptURL) {
    throw new Error("Cannot update without a stable active service worker script");
  }
  const stableActiveWorker = activeWorker;

  return new Promise<InstalledServiceWorkerUpdateResult>((resolve, reject) => {
    let observedWorker: ServiceWorker | null = null;
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      finish(new Error("Waiting service worker installation timed out"));
    }, timeoutMs);

    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      stableRegistration.removeEventListener("updatefound", observeInstallingWorker);
      observedWorker?.removeEventListener("statechange", inspectWorker);
    };

    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve({ state: "installed", waiting: true });
      }
    };

    const inspectWorker = () => {
      if (observedWorker?.state === "installed" && stableRegistration.waiting === observedWorker) {
        finish();
      } else if (observedWorker?.state === "redundant") {
        finish(new Error("Lifecycle update became redundant"));
      }
    };

    function observeInstallingWorker() {
      const worker = stableRegistration.installing;
      if (!worker || observedWorker === worker) {
        return;
      }
      observedWorker?.removeEventListener("statechange", inspectWorker);
      observedWorker = worker;
      worker.addEventListener("statechange", inspectWorker);
      inspectWorker();
    }

    stableRegistration.addEventListener("updatefound", observeInstallingWorker);
    observeInstallingWorker();
    if (
      stableRegistration.active !== stableActiveWorker ||
      stableActiveWorker.state !== "activated"
    ) {
      finish(new Error("Active service worker changed before update"));
      return;
    }
    void stableRegistration.update().catch(finish);
  });
}

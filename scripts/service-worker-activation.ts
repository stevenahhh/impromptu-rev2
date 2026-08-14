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
      const inspectState = () => inspectRegistration();
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
    if (settled) {
      return;
    }

    void registration.update().then(inspectRegistration).catch(finish);
  });
}

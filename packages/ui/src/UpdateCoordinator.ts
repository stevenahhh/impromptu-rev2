export const ACTIVATION_MESSAGE = "IMPROMPTU_ACTIVATE_UPDATE" as const;
const ACTIVATION_ACCEPTED_MESSAGE = "IMPROMPTU_UPDATE_ACTIVATION_ACCEPTED" as const;

export const UPDATE_EVENTS = {
  activationFailed: "impromptu:update-activation-failed",
  coordinatorReady: "impromptu:update-coordinator-ready",
  operatorConfirmed: "impromptu:update-operator-confirmed",
  sessionEnded: "impromptu:presentation-session-ended",
  sessionStarted: "impromptu:presentation-session-started",
  updateReady: "impromptu:update-ready",
} as const;

export type ActivationReason = "OPERATOR_CONFIRMED" | "SESSION_ENDED";

function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number, message: string) {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}

function waitForActivation(worker: ServiceWorker) {
  if (worker.state === "activated") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const onStateChange = () => {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", onStateChange);
        resolve();
      } else if (worker.state === "redundant") {
        worker.removeEventListener("statechange", onStateChange);
        reject(new Error("Waiting service worker became redundant before activation"));
      }
    };
    worker.addEventListener("statechange", onStateChange);
  });
}

export class UpdateCoordinator {
  readonly #container: ServiceWorkerContainer;
  readonly #timeoutMilliseconds: number;
  #registration: ServiceWorkerRegistration | null = null;
  #registrationPromise: Promise<ServiceWorkerRegistration> | null = null;
  #sessionActive = false;
  #waitingWorker: ServiceWorker | null = null;

  constructor(container: ServiceWorkerContainer, timeoutMilliseconds = 10_000) {
    this.#container = container;
    this.#timeoutMilliseconds = timeoutMilliseconds;
  }

  get sessionActive() {
    return this.#sessionActive;
  }

  get updateReady() {
    return this.#waitingWorker !== null;
  }

  register(scriptUrl: string) {
    if (this.#registrationPromise) {
      return this.#registrationPromise;
    }

    const registrationPromise = this.#container
      .register(scriptUrl, { scope: "/" })
      .then((registration) => {
        this.#registration = registration;
        this.#observeRegistration(registration);

        if (registration.waiting && this.#container.controller) {
          this.#rememberWaitingWorker(registration.waiting);
        }

        return registration;
      });
    this.#registrationPromise = registrationPromise;
    void registrationPromise.catch(() => {
      if (this.#registrationPromise === registrationPromise) {
        this.#registrationPromise = null;
      }
    });
    return registrationPromise;
  }

  startSession() {
    this.#sessionActive = true;
  }

  async endSession() {
    this.#sessionActive = false;
    return this.#activateWaitingWorker("SESSION_ENDED");
  }

  async confirmActivation() {
    return this.#activateWaitingWorker("OPERATOR_CONFIRMED");
  }

  #observeRegistration(registration: ServiceWorkerRegistration) {
    const observeInstallingWorker = () => {
      const installing = registration.installing;
      if (!installing) {
        return;
      }

      const inspectState = () => {
        if (installing.state === "installed" && this.#container.controller) {
          this.#rememberWaitingWorker(registration.waiting ?? installing);
        }
      };
      installing.addEventListener("statechange", inspectState);
      inspectState();
    };

    registration.addEventListener("updatefound", observeInstallingWorker);
    observeInstallingWorker();
  }

  #rememberWaitingWorker(worker: ServiceWorker) {
    this.#waitingWorker = worker;
    window.dispatchEvent(new CustomEvent(UPDATE_EVENTS.updateReady));
  }

  async #activateWaitingWorker(reason: ActivationReason) {
    const worker = this.#registration?.waiting ?? this.#waitingWorker;
    if (!worker) {
      return false;
    }

    const channel = new MessageChannel();
    const accepted = new Promise<void>((resolve, reject) => {
      channel.port1.addEventListener("message", (event: MessageEvent<unknown>) => {
        const data = event.data as { type?: unknown };
        if (data.type === ACTIVATION_ACCEPTED_MESSAGE) {
          resolve();
        } else {
          reject(new Error("Waiting service worker rejected the activation handshake"));
        }
      });
      channel.port1.start();
    });
    const activated = waitForActivation(worker);

    worker.postMessage({ type: ACTIVATION_MESSAGE, reason }, [channel.port2]);
    await Promise.all([
      withTimeout(accepted, this.#timeoutMilliseconds, "Update activation handshake timed out"),
      withTimeout(
        activated,
        this.#timeoutMilliseconds,
        "Waiting service worker activation timed out",
      ),
    ]);

    channel.port1.close();
    this.#waitingWorker = null;
    return true;
  }
}

export function bindUpdateCoordinator(coordinator: UpdateCoordinator) {
  const reportFailure = (error: unknown) => {
    window.dispatchEvent(new CustomEvent(UPDATE_EVENTS.activationFailed, { detail: error }));
  };
  const sessionStarted = () => coordinator.startSession();
  const sessionEnded = () => {
    void coordinator.endSession().catch(reportFailure);
  };
  const operatorConfirmed = () => {
    void coordinator.confirmActivation().catch(reportFailure);
  };

  window.addEventListener(UPDATE_EVENTS.sessionStarted, sessionStarted);
  window.addEventListener(UPDATE_EVENTS.sessionEnded, sessionEnded);
  window.addEventListener(UPDATE_EVENTS.operatorConfirmed, operatorConfirmed);

  return () => {
    window.removeEventListener(UPDATE_EVENTS.sessionStarted, sessionStarted);
    window.removeEventListener(UPDATE_EVENTS.sessionEnded, sessionEnded);
    window.removeEventListener(UPDATE_EVENTS.operatorConfirmed, operatorConfirmed);
  };
}

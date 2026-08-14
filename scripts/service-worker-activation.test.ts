import { describe, expect, test } from "bun:test";

import {
  waitForFirstServiceWorkerActivation,
  waitForInstalledServiceWorkerUpdate,
} from "./service-worker-activation.ts";

class FakeWorker extends EventTarget {
  onStateChangeSubscribed: (() => void) | null = null;
  readonly scriptURL: string;
  state: ServiceWorkerState;
  stateChangeSubscriptions = 0;
  readonly #stateChangeListeners = new Set<EventListenerOrEventListenerObject>();

  constructor(state: ServiceWorkerState, scriptURL = "http://example.test/sw.js") {
    super();
    this.state = state;
    this.scriptURL = scriptURL;
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ) {
    if (type !== "statechange" || !callback) {
      super.addEventListener(type, callback, options);
      return;
    }
    this.#stateChangeListeners.add(callback);
    this.stateChangeSubscriptions += 1;
    const subscribed = this.onStateChangeSubscribed;
    this.onStateChangeSubscribed = null;
    subscribed?.();
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ) {
    if (type !== "statechange" || !callback) {
      super.removeEventListener(type, callback, options);
      return;
    }
    this.#stateChangeListeners.delete(callback);
  }

  transition(state: ServiceWorkerState) {
    this.state = state;
    const event = new Event("statechange");
    for (const listener of [...this.#stateChangeListeners]) {
      if (typeof listener === "function") {
        listener.call(this, event);
      } else {
        listener.handleEvent(event);
      }
    }
  }
}

class FakeRegistration extends EventTarget {
  active: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  updateCalls = 0;
  updateWorker: FakeWorker | null = null;
  waiting: FakeWorker | null = null;

  async update() {
    if (this.active?.state !== "activated" || !this.active.scriptURL) {
      throw new Error("Update triggered without a stable active worker");
    }
    this.updateCalls += 1;
    const worker = this.updateWorker;
    if (!worker) {
      throw new Error("Update worker is missing");
    }
    this.installing = worker;
    this.dispatchEvent(new Event("updatefound"));
    this.installing = null;
    this.waiting = worker;
    worker.transition("installed");
  }
}

function installServiceWorkerContainer(registration: FakeRegistration) {
  const original = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: async () => registration,
      register: async () => registration,
    },
  });
  return () => {
    if (original) {
      Object.defineProperty(navigator, "serviceWorker", original);
    } else {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  };
}

describe("first service worker activation observer", () => {
  test("accepts an authoritative activation that completed before observation without updating", async () => {
    const registration = new FakeRegistration();
    registration.active = new FakeWorker("activated");
    const restore = installServiceWorkerContainer(registration);

    try {
      const result = await waitForFirstServiceWorkerActivation({
        scriptUrl: "/sw.js",
        timeoutMs: 100,
      });
      expect(result).toEqual({ state: "activated" });
      expect(registration.updateCalls).toBe(0);
    } finally {
      restore();
    }
  });

  test("passively observes a normally ordered first install without updating", async () => {
    const registration = new FakeRegistration();
    const worker = new FakeWorker("installing");
    registration.installing = worker;
    worker.onStateChangeSubscribed = () => {
      worker.transition("installed");
      registration.installing = null;
      registration.waiting = worker;
      worker.transition("activating");
      registration.waiting = null;
      registration.active = worker;
      worker.transition("activated");
    };
    const restore = installServiceWorkerContainer(registration);

    try {
      const result = await waitForFirstServiceWorkerActivation({
        scriptUrl: "/sw.js",
        timeoutMs: 100,
      });
      expect(result).toEqual({ state: "activated" });
      expect(registration.updateCalls).toBe(0);
      expect(registration.active?.state).toBe("activated");
    } finally {
      restore();
    }
  });

  test("rechecks authority in one task after activated statechange and microtasks", async () => {
    const registration = new FakeRegistration();
    const worker = new FakeWorker("installing");
    registration.installing = worker;
    worker.onStateChangeSubscribed = () => {
      queueMicrotask(() => {
        worker.transition("installed");
        registration.installing = null;
        registration.waiting = worker;
        worker.transition("activating");
        registration.waiting = null;
        worker.transition("activated");
        queueMicrotask(() => {
          queueMicrotask(() => {
            registration.active = worker;
          });
        });
      });
    };
    const restore = installServiceWorkerContainer(registration);

    try {
      const result = await waitForFirstServiceWorkerActivation({
        scriptUrl: "/sw.js",
        timeoutMs: 100,
      });
      expect(result).toEqual({ state: "activated" });
      expect(registration.updateCalls).toBe(0);
      expect(registration.active).toBe(worker);
    } finally {
      restore();
    }
  });
});

describe("installed service worker update observer", () => {
  test("rejects before update when no stable active script exists", async () => {
    const registration = new FakeRegistration();
    const restore = installServiceWorkerContainer(registration);

    try {
      await expect(waitForInstalledServiceWorkerUpdate({ timeoutMs: 100 })).rejects.toThrow(
        "stable active service worker",
      );
      expect(registration.updateCalls).toBe(0);
    } finally {
      restore();
    }
  });

  test("invokes update exactly once after confirming the active script", async () => {
    const registration = new FakeRegistration();
    registration.active = new FakeWorker("activated", "http://example.test/sw-v1.js");
    registration.updateWorker = new FakeWorker("installing", "http://example.test/sw-v2.js");
    const restore = installServiceWorkerContainer(registration);

    try {
      const result = await waitForInstalledServiceWorkerUpdate({ timeoutMs: 100 });
      expect(result).toEqual({ state: "installed", waiting: true });
      expect(registration.updateCalls).toBe(1);
      expect(registration.waiting).toBe(registration.updateWorker);
    } finally {
      restore();
    }
  });
});

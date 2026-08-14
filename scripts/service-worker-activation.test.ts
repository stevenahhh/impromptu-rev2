import { describe, expect, test } from "bun:test";

import { waitForFirstServiceWorkerActivation } from "./service-worker-activation.ts";

class FakeWorker extends EventTarget {
  state: ServiceWorkerState;
  stateChangeSubscriptions = 0;

  constructor(state: ServiceWorkerState) {
    super();
    this.state = state;
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ) {
    if (type === "statechange") {
      this.stateChangeSubscriptions += 1;
    }
    super.addEventListener(type, callback, options);
  }

  transition(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget {
  active: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  updateCalls = 0;
  waiting: FakeWorker | null = null;

  async update() {
    this.updateCalls += 1;
    const worker = this.installing;
    if (!worker || worker.stateChangeSubscriptions === 0) {
      throw new Error("Update triggered before the installing worker observer was subscribed");
    }
    this.dispatchEvent(new Event("updatefound"));
    worker.transition("installed");
    this.installing = null;
    this.waiting = worker;
    worker.transition("activating");
    this.waiting = null;
    this.active = worker;
    worker.transition("activated");
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
  test("accepts an authoritative activation that completed before observation", async () => {
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

  test("subscribes before a normally ordered install reaches authoritative activation", async () => {
    const registration = new FakeRegistration();
    registration.installing = new FakeWorker("installing");
    const restore = installServiceWorkerContainer(registration);

    try {
      const result = await waitForFirstServiceWorkerActivation({
        scriptUrl: "/sw.js",
        timeoutMs: 100,
      });
      expect(result).toEqual({ state: "activated" });
      expect(registration.updateCalls).toBe(1);
      expect(registration.active?.state).toBe("activated");
    } finally {
      restore();
    }
  });
});

import { afterAll, describe, expect, test } from "bun:test";

import "../../../tests/setup.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { ACTIVATION_MESSAGE, type ActivationReason, UpdateCoordinator } from "./UpdateCoordinator";

afterAll(() => GlobalRegistrator.unregister());

class FakeWorker extends EventTarget {
  messages: Array<{ reason: ActivationReason; type: string }> = [];
  state: ServiceWorkerState = "installed";

  postMessage(message: { reason: ActivationReason; type: string }, transfer: Transferable[]) {
    this.messages.push(message);
    const replyPort = transfer[0] as MessagePort;
    replyPort.postMessage({ type: "IMPROMPTU_UPDATE_ACTIVATION_ACCEPTED" });
    this.state = "activated";
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget {
  active: ServiceWorker | null = null;
  installing: ServiceWorker | null = null;
  waiting: ServiceWorker | null;

  constructor(waiting: FakeWorker | null) {
    super();
    this.waiting = waiting as unknown as ServiceWorker | null;
  }
}

class FakeContainer extends EventTarget {
  controller: ServiceWorker | null;
  readonly registration: FakeRegistration;
  readonly registeredScripts: string[] = [];

  constructor(registration: FakeRegistration, controlled: boolean) {
    super();
    this.registration = registration;
    this.controller = controlled ? ({} as ServiceWorker) : null;
  }

  async register(scriptUrl: string) {
    this.registeredScripts.push(scriptUrl);
    return this.registration as unknown as ServiceWorkerRegistration;
  }
}

function coordinatorFixture({ controlled = true, waiting = true } = {}) {
  const worker = waiting ? new FakeWorker() : null;
  const registration = new FakeRegistration(worker);
  const container = new FakeContainer(registration, controlled);
  const coordinator = new UpdateCoordinator(container as unknown as ServiceWorkerContainer);
  return { container, coordinator, worker };
}

describe("UpdateCoordinator", () => {
  test("leaves first install uncontrolled and sends no activation command", async () => {
    const { container, coordinator } = coordinatorFixture({ controlled: false, waiting: false });

    await coordinator.register("/sw.js");

    expect(container.controller).toBeNull();
    expect(coordinator.updateReady).toBe(false);
  });

  test("defers a waiting update throughout an active presentation", async () => {
    const { coordinator, worker } = coordinatorFixture();
    coordinator.startSession();

    await coordinator.register("/sw.js");

    expect(coordinator.sessionActive).toBe(true);
    expect(coordinator.updateReady).toBe(true);
    expect(worker?.messages).toEqual([]);
  });

  test("shares concurrent registration so a readiness observer cannot replace the release pin", async () => {
    const { container, coordinator } = coordinatorFixture();

    await Promise.all([
      coordinator.register("/sw.js?cohort=stable"),
      coordinator.register("/sw.js"),
    ]);

    expect(container.registeredScripts).toEqual(["/sw.js?cohort=stable"]);
  });

  test("activates only after explicit operator confirmation", async () => {
    const { coordinator, worker } = coordinatorFixture();
    coordinator.startSession();
    await coordinator.register("/sw.js");

    await coordinator.confirmActivation();

    expect(worker?.messages).toEqual([{ type: ACTIVATION_MESSAGE, reason: "OPERATOR_CONFIRMED" }]);
  });

  test("activates a deferred update when the presentation ends", async () => {
    const { coordinator, worker } = coordinatorFixture();
    coordinator.startSession();
    await coordinator.register("/sw.js");

    await coordinator.endSession();

    expect(worker?.messages).toEqual([{ type: ACTIVATION_MESSAGE, reason: "SESSION_ENDED" }]);
  });
});

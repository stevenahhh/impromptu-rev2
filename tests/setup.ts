import { GlobalRegistrator } from "@happy-dom/global-registrator";

// registerDom() files deliberately keep one happy-dom window alive for the whole Bun process
// (unregistering it kills the MessageChannel React's scheduler bound at first render). This
// setup file is imported by suites that own the window themselves, so it must adopt an existing
// registration instead of throwing "already been globally registered" when it runs after one.
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

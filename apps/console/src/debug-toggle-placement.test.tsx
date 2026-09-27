import { afterEach, describe, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

const { cleanup, render } = await import("@testing-library/react");

import type { ActivePresentationView } from "./session-client";

const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider, ConsoleRoutes } = await import("./App");

afterEach(cleanup);

function renderRoute(path: string, authenticated: boolean, presentation?: ActivePresentationView) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider
        initialAuthenticated={authenticated}
        {...(presentation === undefined ? {} : { initialPresentation: presentation })}
      >
        <ConsoleRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

function debugToggle(): HTMLElement | null {
  return document.querySelector(".debug-overlay__toggle");
}

function buttonLabeledDebug(): HTMLElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Debug",
  );
}

describe("debug toggle placement", () => {
  test("sign-in surface renders no Debug control", () => {
    renderRoute("/sign-in", false);
    expect(debugToggle()).toBeNull();
    expect(buttonLabeledDebug()).toBeUndefined();
  });

  test("workspace with a loaded deck keeps the Debug control in dev builds", () => {
    renderRoute("/session", true, {
      presentationSessionId: "ps_test",
      presentationSessionEpoch: "e1",
      deckVersion: "dv_test",
      slides: [],
    });
    expect(debugToggle()).not.toBeNull();
    expect(buttonLabeledDebug()).toBeDefined();
  });

  test("upload screen without a loaded deck renders no Debug control", () => {
    renderRoute("/session", true);
    expect(debugToggle()).toBeNull();
    expect(buttonLabeledDebug()).toBeUndefined();
  });
});

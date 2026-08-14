import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { StageRoutes } = await import("./App");

afterEach(() => {
  cleanup();
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    value: null,
  });
});

function renderStage(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <StageRoutes />
    </MemoryRouter>,
  );
}

describe("public Stage boundary", () => {
  test("keeps both Stage routes public and audience-only", () => {
    renderStage("/");
    expect(within(document.body).getByRole("heading", { name: "A clean screen for the room" })).toBeTruthy();
    expect(within(document.body).queryByText("Private workspace")).toBeNull();

    cleanup();
    renderStage("/display/rehearsal");
    expect(within(document.body).getByRole("heading", { name: "Evidence, without the detour" })).toBeTruthy();
    expect(within(document.body).queryByText("Private workspace")).toBeNull();
  });

  test("enters and exits fullscreen only from a Stage-local action", () => {
    const requestFullscreen = mock(async () => {
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: document.documentElement,
      });
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    const exitFullscreen = mock(async () => {
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: null,
      });
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: exitFullscreen,
    });

    renderStage("/display/rehearsal");
    fireEvent.click(within(document.body).getByRole("button", { name: "Enter fullscreen" }));

    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(within(document.body).getByRole("button", { name: "Exit fullscreen" })).toBeTruthy();

    fireEvent.click(within(document.body).getByRole("button", { name: "Exit fullscreen" }));
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(within(document.body).getByRole("button", { name: "Enter fullscreen" })).toBeTruthy();
  });
});

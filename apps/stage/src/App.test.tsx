import { afterEach, describe, expect, mock, test } from "bun:test";
import "../../../tests/setup.ts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { StageRoutes } from "./App";

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
    expect(screen.getByRole("heading", { name: "A clean screen for the room" })).toBeTruthy();
    expect(screen.queryByText("Private workspace")).toBeNull();

    cleanup();
    renderStage("/display/rehearsal");
    expect(screen.getByRole("heading", { name: "Evidence, without the detour" })).toBeTruthy();
    expect(screen.queryByText("Private workspace")).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));

    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Exit fullscreen" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Enter fullscreen" })).toBeTruthy();
  });
});

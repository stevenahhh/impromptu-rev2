import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, ConsoleRoutes } from "./App";

afterEach(cleanup);

function renderConsole(path: string, authenticated: boolean) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialAuthenticated={authenticated}>
        <ConsoleRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("Console route boundary", () => {
  test("redirects a signed-out visitor away from every private route", () => {
    renderConsole("/session", false);

    expect(screen.getByRole("heading", { name: "Private presentation control" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Session controls" })).toBeNull();
  });

  test("keeps the sign-in route public-only once authenticated", () => {
    renderConsole("/sign-in", true);

    expect(screen.getByRole("heading", { name: "Ready for the room" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Private presentation control" })).toBeNull();
  });

  test("renders an explicit private navigation landmark", () => {
    renderConsole("/", true);

    expect(screen.getByRole("navigation", { name: "Private workspace" })).toBeTruthy();
    expect(screen.getByText("Private workspace")).toBeTruthy();
  });
});

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider, ConsoleRoutes } = await import("./App");

import type { ConsoleSessionClient } from "./session-client";

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

    expect(
      within(document.body).getByRole("heading", { name: "Private presentation control" }),
    ).toBeTruthy();
    expect(within(document.body).queryByRole("heading", { name: "Session controls" })).toBeNull();
  });

  test("keeps the sign-in route public-only once authenticated", () => {
    renderConsole("/sign-in", true);

    expect(within(document.body).getByRole("heading", { name: "Ready for the room" })).toBeTruthy();
    expect(
      within(document.body).queryByRole("heading", { name: "Private presentation control" }),
    ).toBeNull();
  });

  test("renders an explicit private navigation landmark", () => {
    renderConsole("/", true);

    expect(
      within(document.body).getByRole("navigation", { name: "Private workspace" }),
    ).toBeTruthy();
    expect(within(document.body).getByText("Private workspace")).toBeTruthy();
  });

  test("exchanges the entered code through the typed session client without storage", async () => {
    const receivedCodes: string[] = [];
    const client: ConsoleSessionClient = {
      async signIn(code) {
        receivedCodes.push(code);
        return {
          account: { accountId: "account_alpha", actorId: "actor_alpha" },
          expiresAtMs: 10_000,
          csrfToken: "csrf-alpha",
        };
      },
      async readSession() {
        return null;
      },
      async signOut() {},
      async createPresentation() {
        throw new Error("not used");
      },
    };
    render(
      <MemoryRouter initialEntries={["/sign-in"]}>
        <AuthProvider client={client}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    fireEvent.change(within(document.body).getByLabelText("One-time sign-in code"), {
      target: { value: "transient-code" },
    });
    fireEvent.click(within(document.body).getByRole("button", { name: "Enter private workspace" }));

    await waitFor(() => {
      expect(
        within(document.body).getByRole("heading", { name: "Ready for the room" }),
      ).toBeTruthy();
    });
    expect(receivedCodes).toEqual(["transient-code"]);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

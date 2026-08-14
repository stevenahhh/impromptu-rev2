import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { cleanup, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider, ConsoleRoutes } = await import("./App");

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
});

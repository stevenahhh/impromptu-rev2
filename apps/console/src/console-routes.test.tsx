import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { cleanup, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider, ConsoleRoutes } = await import("./App");

afterEach(cleanup);

test("the retired /live-publication route renders a guide-and-return surface, not a silent redirect", async () => {
  render(
    <MemoryRouter initialEntries={["/live-publication"]}>
      <AuthProvider initialAuthenticated>
        <ConsoleRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );

  // The route keeps its own surface: the old URL is explained, then sends the presenter back
  // to the workspace rather than silently bouncing off a dead route.
  const notice = document.querySelector("[data-live-publication-interstitial]");
  expect(notice).toBeTruthy();
  const back = within(notice as HTMLElement).getByRole("link");
  expect(back.getAttribute("href")).toBe("/");
});

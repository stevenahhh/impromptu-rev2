import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { DebugOverlay } = await import("./debug-overlay");
const { createDebugLogger } = await import("./debug-log");

import type { DebugLogger } from "./debug-log";

afterEach(cleanup);

interface SetupResult {
  readonly logger: DebugLogger;
  readonly view: ReturnType<typeof render>;
}

function setup(entryCount: number): SetupResult {
  const logger = createDebugLogger({ forwardToConsole: false });
  logger.debug("state", "state.updated", { detail: { revision: 3 } });
  logger.info("network", "request.sent", { correlationId: "corr-77" });
  logger.warn("upload", "chunk.retry");
  logger.error("ai", "model.failed");
  for (let i = 0; i < entryCount - 4; i += 1) {
    logger.debug("render", `filler-${i}`);
  }
  const view = render(<DebugOverlay logger={logger} />);
  return { logger, view };
}

function toggleButton(view: SetupResult["view"]): HTMLButtonElement {
  const toggle = view.container.querySelector<HTMLButtonElement>("button.debug-overlay__toggle");
  if (toggle === null) {
    throw new Error("toggle button not found");
  }
  return toggle;
}

function openPanel(view: SetupResult["view"]): void {
  act(() => {
    fireEvent.click(toggleButton(view));
  });
}

describe("DebugOverlay", () => {
  test("starts closed and toggles open/closed via the floating control", () => {
    const { view } = setup(4);
    const root = view.container.querySelector<HTMLElement>('[data-debug-overlay="closed"]');
    expect(root).not.toBeNull();
    expect(view.container.querySelectorAll("[data-debug-entry]").length).toBe(0);

    openPanel(view);
    expect(view.container.querySelector('[data-debug-overlay="open"]')).not.toBeNull();
    expect(view.container.querySelectorAll("[data-debug-entry]").length).toBe(4);

    act(() => {
      fireEvent.click(toggleButton(view));
    });
    expect(view.container.querySelector('[data-debug-overlay="closed"]')).not.toBeNull();
  });

  test("renders level, source, and correlation id on each entry row", () => {
    const { view } = setup(4);
    openPanel(view);
    const rows = [...view.container.querySelectorAll<HTMLElement>("[data-debug-entry]")];
    expect(rows.length).toBe(4);
    const networkRow = rows.find((row) => row.dataset.debugLevel === "INFO");
    expect(networkRow?.dataset.debugSource).toBe("network");
    expect(networkRow?.textContent).toContain("corr-77");
    expect(networkRow?.textContent).toContain("request.sent");
    const aiRow = rows.find((row) => row.dataset.debugSource === "ai");
    expect(aiRow?.dataset.debugLevel).toBe("ERROR");
  });

  test("keyboard shortcut ctrl/cmd+shift+d toggles the panel", () => {
    const { view } = setup(4);
    expect(view.container.querySelector('[data-debug-overlay="closed"]')).not.toBeNull();
    act(() => {
      fireEvent.keyDown(window, { key: "d", ctrlKey: true, shiftKey: true });
    });
    expect(view.container.querySelector('[data-debug-overlay="open"]')).not.toBeNull();
    act(() => {
      fireEvent.keyDown(window, { key: "D", shiftKey: true, metaKey: true });
    });
    expect(view.container.querySelector('[data-debug-overlay="closed"]')).not.toBeNull();
  });

  test("filters visible entries by level and by source", () => {
    const { view } = setup(8);
    openPanel(view);
    expect(view.container.querySelectorAll("[data-debug-entry]").length).toBe(8);

    const levelSelect = view.container.querySelector<HTMLSelectElement>(
      "select[data-debug-filter-level]",
    );
    expect(levelSelect).not.toBeNull();
    const sourceSelect = view.container.querySelector<HTMLSelectElement>(
      "select[data-debug-filter-source]",
    );
    expect(sourceSelect).not.toBeNull();

    act(() => {
      fireEvent.change(levelSelect as HTMLSelectElement, { target: { value: "ERROR" } });
    });
    let rows = [...view.container.querySelectorAll<HTMLElement>("[data-debug-entry]")];
    expect(rows.length).toBe(1);
    expect(rows[0]?.dataset.debugLevel).toBe("ERROR");

    act(() => {
      fireEvent.change(levelSelect as HTMLSelectElement, { target: { value: "ALL" } });
      fireEvent.change(sourceSelect as HTMLSelectElement, { target: { value: "render" } });
    });
    rows = [...view.container.querySelectorAll<HTMLElement>("[data-debug-entry]")];
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.dataset.debugSource).toBe("render");
    }
  });

  test("copy-all writes every visible entry to the clipboard", async () => {
    const { view } = setup(6);
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
      configurable: true,
    });
    openPanel(view);
    const copyButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => /copy all/i.test(button.textContent ?? ""),
    );
    expect(copyButton).toBeDefined();
    await act(async () => {
      fireEvent.click(copyButton as HTMLButtonElement);
    });
    expect(copied).toContain("model.failed");
    expect(copied).toContain("ERROR");
  });

  test("clear empties the buffer through the logger", () => {
    const { logger, view }: SetupResult = setup(5);
    openPanel(view);
    const clearButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => /^clear$/i.test(button.textContent?.trim() ?? ""),
    );
    expect(clearButton).toBeDefined();
    act(() => {
      fireEvent.click(clearButton as HTMLButtonElement);
    });
    expect(logger.entries().length).toBe(0);
    expect(view.container.querySelectorAll("[data-debug-entry]").length).toBe(0);
  });
});

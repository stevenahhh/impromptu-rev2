import { describe, expect, test } from "bun:test";
import {
  emergencyPublicSlideSet,
  observeWindowsTopology,
  topologyInstructions,
  windowsDisplayMode,
} from "./windows-topology";

const key = (value: string, overrides: Partial<KeyboardEvent> = {}) => ({
  key: value,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe("Windows Stage topology", () => {
  test("makes manual Extend, public-only Duplicate, and Stage-only fallback explicit", () => {
    expect(windowsDisplayMode("extend")).toBe("extend");
    expect(windowsDisplayMode("duplicate")).toBe("duplicate");
    expect(windowsDisplayMode("single")).toBe("single");
    expect(windowsDisplayMode("unknown")).toBe("extend");
    expect(topologyInstructions("extend").join(" ")).toContain("Drag this Stage");
    expect(topologyInstructions("duplicate").join(" ")).toContain("only session on this PC");
    expect(topologyInstructions("single").join(" ")).toContain("public slides only");
  });

  test("maps the emergency keyboard fallback only to absolute public slide sets", () => {
    const slides = ["slide_public_1", "slide_public_2", "slide_public_3"];
    expect(emergencyPublicSlideSet(key("ArrowRight"), slides, slides[0] ?? "")).toEqual({
      kind: "PUBLIC_SLIDE_ABSOLUTE_SET",
      publicSlideKey: "slide_public_2",
    });
    expect(emergencyPublicSlideSet(key("End"), slides, slides[0] ?? "")).toEqual({
      kind: "PUBLIC_SLIDE_ABSOLUTE_SET",
      publicSlideKey: "slide_public_3",
    });
    for (const privateAttempt of ["p", "c", "Enter", " ", "Delete", "F1"]) {
      expect(emergencyPublicSlideSet(key(privateAttempt), slides, slides[0] ?? "")).toBeNull();
    }
    expect(
      emergencyPublicSlideSet(key("ArrowRight", { ctrlKey: true }), slides, slides[0] ?? ""),
    ).toBeNull();
  });

  test("uses Window Management API when available and deterministic fallback otherwise", async () => {
    const details = Object.assign(new EventTarget(), { screens: [{}, {}] });
    expect(await observeWindowsTopology({ getScreenDetails: async () => details }, 1)).toEqual({
      observation: { source: "window-management", screenCount: 2 },
      details,
    });
    expect(await observeWindowsTopology({}, 1)).toEqual({
      observation: { source: "deterministic-fallback", screenCount: 1 },
      details: null,
    });
  });
});

import { describe, expect, test } from "bun:test";
import {
  emergencyPublicSlideSet,
  manualPlacementSummary,
  observeWindowsTopology,
  placeStageOnTargetScreen,
  recoverTargetScreenLoss,
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
  test("makes manual Extend, public-only Duplicate, and audience-screen fallback explicit", () => {
    expect(windowsDisplayMode("extend")).toBe("extend");
    expect(windowsDisplayMode("duplicate")).toBe("duplicate");
    expect(windowsDisplayMode("single")).toBe("single");
    expect(windowsDisplayMode("unknown")).toBe("extend");
    expect(topologyInstructions("extend").join(" ")).toContain("프로젝터로 옮긴 뒤");
    expect(topologyInstructions("duplicate").join(" ")).toContain("발표 화면만 열린");
    expect(topologyInstructions("single").join(" ")).toContain("공개 슬라이드만");
    expect(manualPlacementSummary("duplicate")).toContain("발표 화면만 남기고");
    expect(manualPlacementSummary("single")).toContain("발표 화면에는 이 화면만");
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

  test("places Stage on a deterministic non-primary target when changeScreen is available", async () => {
    const primary = { isPrimary: true, label: "Built-in", left: 0, top: 0 };
    const projector = { isPrimary: false, label: "Projector", left: 1920, top: 0 };
    const details = Object.assign(new EventTarget(), {
      screens: [projector, primary],
      currentScreen: primary,
    });
    const placements: unknown[] = [];
    const result = await placeStageOnTargetScreen(
      {
        getScreenDetails: async () => details,
        async changeScreen(options) {
          placements.push(options.screen);
        },
      },
      details,
    );
    expect(result).toEqual({ status: "TARGET_PLACED", target: projector });
    expect(placements).toEqual([projector]);
  });

  test("recovers target loss to a remaining screen and falls back cleanly without changeScreen", async () => {
    const lost = { isPrimary: false, label: "Projector", left: 1920, top: 0 };
    const primary = { isPrimary: true, label: "Built-in", left: 0, top: 0 };
    const remaining = Object.assign(new EventTarget(), {
      screens: [primary],
      currentScreen: primary,
    });
    const placements: unknown[] = [];
    expect(
      await recoverTargetScreenLoss(
        {
          async changeScreen({ screen }) {
            placements.push(screen);
          },
        },
        remaining,
        lost,
      ),
    ).toEqual({ status: "TARGET_LOST_RECOVERED", target: primary });
    expect(placements).toEqual([primary]);
    expect(await recoverTargetScreenLoss({}, remaining, lost)).toEqual({
      status: "MANUAL_FALLBACK",
      target: null,
    });
  });
});

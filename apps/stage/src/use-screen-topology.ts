import { useEffect, useRef, useState } from "react";
import { publishStageEvent } from "./stage-events";
import { useStageCopy } from "./stage-i18n";
import {
  manualPlacementSummary,
  observeWindowsTopology,
  placeStageOnTargetScreen,
  recoverTargetScreenLoss,
  type ScreenDetailsLike,
  type ScreenLike,
  type WindowsDisplayMode,
  windowsDisplayMode,
} from "./windows-topology";

/**
 * Owns the observed display topology of this window: which mode the browser reports, whether the
 * audience screen sits on its target, and the assistive-only placement summary. Placement runs
 * automatically — a bare audience screen has no buttons.
 */
export function useScreenTopology(requestedMode: WindowsDisplayMode): {
  readonly mode: WindowsDisplayMode;
  readonly placementMessage: string;
} {
  const copy = useStageCopy();
  const [mode, setMode] = useState(requestedMode);
  const [placementMessage, setPlacementMessage] = useState(() =>
    manualPlacementSummary(requestedMode, copy),
  );
  const detailsRef = useRef<ScreenDetailsLike | null>(null);
  const targetRef = useRef<ScreenLike | null>(null);

  useEffect(() => {
    let active = true;
    const windowManager = window as unknown as Parameters<typeof observeWindowsTopology>[0];
    const apply = (observedMode: ReturnType<typeof windowsDisplayMode>, count: number) => {
      setMode(observedMode);
      publishStageEvent("impromptu:topology-change", {
        requestedMode,
        observedMode,
        screenCount: count,
      });
    };
    const reportPlacement = (
      status: "TARGET_PLACED" | "TARGET_LOST_RECOVERED" | "MANUAL_FALLBACK",
    ) => {
      setPlacementMessage(
        status === "TARGET_PLACED"
          ? copy.targetPlaced
          : status === "TARGET_LOST_RECOVERED"
            ? copy.targetRecovered
            : manualPlacementSummary(requestedMode, copy),
      );
    };
    const sync = async () => {
      const details = detailsRef.current;
      const count = details?.screens.length ?? 1;
      const target = targetRef.current;
      if (details !== null && target !== null) {
        const recovery = await recoverTargetScreenLoss(windowManager, details, target);
        if (!active) return;
        targetRef.current = recovery.target;
        reportPlacement(recovery.status);
        if (recovery.status !== "TARGET_PLACED") {
          publishStageEvent("impromptu:target-screen-recovery", {
            status: recovery.status,
            privatePixelCount: 0,
          });
        }
      }
      apply(count > 1 ? "extend" : requestedMode === "single" ? "single" : "duplicate", count);
    };
    const bindDetails = (details: ScreenDetailsLike | null) => {
      detailsRef.current?.removeEventListener("screenschange", sync);
      detailsRef.current = details;
      details?.addEventListener("screenschange", sync);
    };
    const observeOrPlaceTarget = async (shouldPlace: boolean) => {
      const extendedScreen = window.screen as Screen & { readonly isExtended?: boolean };
      const result = await observeWindowsTopology(
        windowManager,
        extendedScreen.isExtended === true ? 2 : 1,
      );
      if (!active) return;
      bindDetails(result.details);
      if (shouldPlace || result.observation.screenCount !== 1) {
        apply(requestedMode, result.observation.screenCount);
      }
      const placement =
        !shouldPlace || result.details === null
          ? { status: "MANUAL_FALLBACK" as const, target: null }
          : await placeStageOnTargetScreen(windowManager, result.details);
      if (!active) return;
      targetRef.current = placement.target;
      if (shouldPlace) {
        reportPlacement(placement.status);
        publishStageEvent("impromptu:target-screen-placement", {
          status: placement.status,
          privatePixelCount: 0,
        });
      }
    };
    const onPlacementRequest = () => void observeOrPlaceTarget(true);
    const onPlatformTopology = (event: Event) => {
      if (
        !(event instanceof CustomEvent) ||
        typeof event.detail !== "object" ||
        event.detail === null
      )
        return;
      const detail = event.detail as Record<string, unknown>;
      const observedMode = windowsDisplayMode(
        typeof detail.observedMode === "string" ? detail.observedMode : null,
      );
      const count = typeof detail.screenCount === "number" ? detail.screenCount : 1;
      if (detail.targetScreenLost === true) {
        targetRef.current = null;
        reportPlacement("MANUAL_FALLBACK");
        publishStageEvent("impromptu:target-screen-recovery", {
          status: "MANUAL_FALLBACK",
          privatePixelCount: 0,
        });
      }
      apply(observedMode, count);
    };
    // Placement used to wait for a button press; a bare audience screen has no buttons, so the
    // display now claims its target screen automatically on mount and after every topology sync.
    void observeOrPlaceTarget(true);
    window.addEventListener("resize", sync);
    window.addEventListener("impromptu:platform-topology-change", onPlatformTopology);
    window.addEventListener("impromptu:target-screen-placement-request", onPlacementRequest);
    return () => {
      active = false;
      detailsRef.current?.removeEventListener("screenschange", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("impromptu:platform-topology-change", onPlatformTopology);
      window.removeEventListener("impromptu:target-screen-placement-request", onPlacementRequest);
    };
  }, [requestedMode, copy]);

  return { mode, placementMessage };
}

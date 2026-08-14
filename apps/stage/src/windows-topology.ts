export type WindowsDisplayMode = "extend" | "duplicate" | "single";

export type WindowsTopologyFault =
  | "popup-blocked"
  | "fullscreen-exit"
  | "monitor-unplug"
  | "topology-switch"
  | "browser-refresh"
  | "controller-background"
  | "projection-drop";

export interface PublicSlideSet {
  readonly kind: "PUBLIC_SLIDE_ABSOLUTE_SET";
  readonly publicSlideKey: string;
}

export interface ScreenLike {
  readonly isPrimary?: boolean;
  readonly label?: string;
}

export interface ScreenDetailsLike extends EventTarget {
  readonly screens: readonly ScreenLike[];
  readonly currentScreen?: ScreenLike;
}

export interface WindowManagementLike {
  getScreenDetails?: () => Promise<ScreenDetailsLike>;
}

export interface TopologyObservation {
  readonly source: "window-management" | "deterministic-fallback";
  readonly screenCount: number;
}

export function windowsDisplayMode(value: string | null): WindowsDisplayMode {
  return value === "duplicate" || value === "single" ? value : "extend";
}

export function topologyInstructions(mode: WindowsDisplayMode): readonly string[] {
  if (mode === "extend") {
    return [
      "Open only Public Stage on the presentation PC.",
      "Drag this Stage to the projector, then enter fullscreen here.",
      "Keep the private controller on a separate phone, tablet, or laptop.",
    ];
  }
  if (mode === "duplicate") {
    return [
      "Use a clean Public Stage browser profile as the only session on this PC.",
      "Keep the private controller on a separate phone, tablet, or laptop.",
      "If Win+P changes the topology, keep Stage public and restore fullscreen here.",
    ];
  }
  return [
    "Keep Stage as the only app on the shared audience screen.",
    "Keep the private controller on a separate phone, tablet, or laptop.",
    "Emergency keyboard navigation changes public slides only.",
  ];
}

export function emergencyPublicSlideSet(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  orderedPublicSlideKeys: readonly string[],
  currentPublicSlideKey: string,
): PublicSlideSet | null {
  if (
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    orderedPublicSlideKeys.length === 0
  ) {
    return null;
  }
  const currentIndex = Math.max(0, orderedPublicSlideKeys.indexOf(currentPublicSlideKey));
  let nextIndex: number;
  switch (event.key) {
    case "ArrowRight":
    case "PageDown":
      nextIndex = Math.min(orderedPublicSlideKeys.length - 1, currentIndex + 1);
      break;
    case "ArrowLeft":
    case "PageUp":
      nextIndex = Math.max(0, currentIndex - 1);
      break;
    case "Home":
      nextIndex = 0;
      break;
    case "End":
      nextIndex = orderedPublicSlideKeys.length - 1;
      break;
    default:
      return null;
  }
  const publicSlideKey = orderedPublicSlideKeys[nextIndex];
  return publicSlideKey === undefined
    ? null
    : { kind: "PUBLIC_SLIDE_ABSOLUTE_SET", publicSlideKey };
}

export async function observeWindowsTopology(
  browserWindow: WindowManagementLike,
  fallbackScreenCount: number,
): Promise<Readonly<{ observation: TopologyObservation; details: ScreenDetailsLike | null }>> {
  if (browserWindow.getScreenDetails === undefined) {
    return {
      observation: {
        source: "deterministic-fallback",
        screenCount: Math.max(1, fallbackScreenCount),
      },
      details: null,
    };
  }
  try {
    const details = await browserWindow.getScreenDetails();
    return {
      observation: { source: "window-management", screenCount: details.screens.length },
      details,
    };
  } catch {
    return {
      observation: {
        source: "deterministic-fallback",
        screenCount: Math.max(1, fallbackScreenCount),
      },
      details: null,
    };
  }
}

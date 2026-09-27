export type WindowsDisplayMode = "extend" | "duplicate" | "single";

export type WindowsTopologyFault =
  | "popup-blocked"
  | "fullscreen-exit"
  | "monitor-unplug"
  | "target-screen-loss"
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
  readonly left?: number;
  readonly top?: number;
}

export interface ScreenDetailsLike extends EventTarget {
  readonly screens: readonly ScreenLike[];
  readonly currentScreen?: ScreenLike;
}

export interface WindowManagementLike {
  getScreenDetails?: () => Promise<ScreenDetailsLike>;
  changeScreen?: (options: Readonly<{ screen: ScreenLike }>) => Promise<void>;
}

export interface TargetScreenPlacement {
  readonly status: "TARGET_PLACED" | "TARGET_LOST_RECOVERED" | "MANUAL_FALLBACK";
  readonly target: ScreenLike | null;
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
      "발표 PC에는 발표 화면만 열어 주세요.",
      "이 창을 프로젝터로 옮긴 뒤 전체 화면으로 보여 주세요.",
      "발표자 화면은 다른 휴대폰, 태블릿, 노트북에서 열어 주세요.",
    ];
  }
  if (mode === "duplicate") {
    return [
      "이 PC에서는 발표 화면만 열린 브라우저 프로필을 사용해 주세요.",
      "발표자 화면은 다른 휴대폰, 태블릿, 노트북에서 열어 주세요.",
      "Win+P로 화면 구성이 바뀌면 발표 화면만 남기고 다시 전체 화면으로 보여 주세요.",
    ];
  }
  return [
    "공유 화면에는 발표 화면만 보여 주세요.",
    "발표자 화면은 다른 휴대폰, 태블릿, 노트북에서 열어 주세요.",
    "비상 키보드로는 공개 슬라이드만 바꿀 수 있어요.",
  ];
}

export function manualPlacementSummary(mode: WindowsDisplayMode): string {
  if (mode === "duplicate") {
    return "수동 배치: 이 PC에는 발표 화면만 남기고 발표자 화면은 다른 기기에서 연 뒤 전체 화면으로 보여 주세요.";
  }
  if (mode === "single") {
    return "수동 배치: 발표 화면에는 이 화면만 남긴 뒤 전체 화면으로 보여 주세요.";
  }
  return "수동 배치: 이 창을 대상 화면으로 옮긴 뒤 전체 화면으로 보여 주세요.";
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

function screenIdentity(screen: ScreenLike): string {
  return `${screen.label ?? ""}:${screen.left ?? 0}:${screen.top ?? 0}:${screen.isPrimary === true}`;
}

export function screenIsPresent(details: ScreenDetailsLike, screen: ScreenLike): boolean {
  const identity = screenIdentity(screen);
  return details.screens.some(
    (candidate) => candidate === screen || screenIdentity(candidate) === identity,
  );
}

function deterministicTarget(details: ScreenDetailsLike): ScreenLike | null {
  const ordered = [...details.screens].sort((left, right) =>
    screenIdentity(left).localeCompare(screenIdentity(right)),
  );
  return (
    ordered.find((screen) => screen.isPrimary !== true && screen !== details.currentScreen) ??
    ordered.find((screen) => screen.isPrimary !== true) ??
    null
  );
}

export async function placeStageOnTargetScreen(
  browserWindow: WindowManagementLike,
  details: ScreenDetailsLike,
): Promise<TargetScreenPlacement> {
  const target = deterministicTarget(details);
  if (target === null || browserWindow.changeScreen === undefined) {
    return { status: "MANUAL_FALLBACK", target: null };
  }
  try {
    await browserWindow.changeScreen({ screen: target });
    return { status: "TARGET_PLACED", target };
  } catch {
    return { status: "MANUAL_FALLBACK", target: null };
  }
}

export async function recoverTargetScreenLoss(
  browserWindow: WindowManagementLike,
  details: ScreenDetailsLike,
  previousTarget: ScreenLike,
): Promise<TargetScreenPlacement> {
  if (screenIsPresent(details, previousTarget)) {
    return { status: "TARGET_PLACED", target: previousTarget };
  }
  const recoveryTarget =
    deterministicTarget(details) ?? details.currentScreen ?? details.screens[0];
  if (recoveryTarget === undefined || browserWindow.changeScreen === undefined) {
    return { status: "MANUAL_FALLBACK", target: null };
  }
  try {
    await browserWindow.changeScreen({ screen: recoveryTarget });
    return { status: "TARGET_LOST_RECOVERED", target: recoveryTarget };
  } catch {
    return { status: "MANUAL_FALLBACK", target: null };
  }
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

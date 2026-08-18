import { bindUpdateCoordinator, UPDATE_EVENTS, UpdateCoordinator } from "@impromptu/ui";

let updateCoordinator: UpdateCoordinator | null = null;

export function registerConsoleServiceWorker() {
  if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") {
    return null;
  }
  if (updateCoordinator) {
    return updateCoordinator;
  }

  updateCoordinator = new UpdateCoordinator(navigator.serviceWorker);
  bindUpdateCoordinator(updateCoordinator);
  const cohort = encodeURIComponent(process.env.NEXT_PUBLIC_SW_COHORT ?? "stable");
  void updateCoordinator.register(`/sw.js?cohort=${cohort}`).catch((error: unknown) => {
    window.dispatchEvent(new CustomEvent(UPDATE_EVENTS.activationFailed, { detail: error }));
  });

  void updateCoordinator
    .register("/sw.js")
    .then(() => {
      Reflect.set(window, "__impromptuUpdateCoordinatorReady", true);
      window.dispatchEvent(new CustomEvent(UPDATE_EVENTS.coordinatorReady));
    })
    .catch((error: unknown) => {
      window.dispatchEvent(new CustomEvent(UPDATE_EVENTS.activationFailed, { detail: error }));
    });
  return updateCoordinator;
}

import { bindUpdateCoordinator, UPDATE_EVENTS, UpdateCoordinator } from "@impromptu/ui";

let updateCoordinator: UpdateCoordinator | null = null;

export function registerStageServiceWorker() {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) {
    return null;
  }
  if (updateCoordinator) {
    return updateCoordinator;
  }

  updateCoordinator = new UpdateCoordinator(navigator.serviceWorker);
  bindUpdateCoordinator(updateCoordinator);
  const cohort = encodeURIComponent(import.meta.env.IMPROMPTU_SW_COHORT ?? "stable");
  void updateCoordinator.register(`/sw.js?cohort=${cohort}`).catch((error: unknown) => {
    window.dispatchEvent(new CustomEvent(UPDATE_EVENTS.activationFailed, { detail: error }));
  });
  return updateCoordinator;
}

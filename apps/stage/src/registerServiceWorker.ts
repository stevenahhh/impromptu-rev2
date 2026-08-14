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
  void updateCoordinator.register("/sw.js").catch((error: unknown) => {
    window.dispatchEvent(new CustomEvent(UPDATE_EVENTS.activationFailed, { detail: error }));
  });
  return updateCoordinator;
}

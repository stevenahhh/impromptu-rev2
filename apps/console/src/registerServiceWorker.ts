export function registerConsoleServiceWorker() {
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" });
  }
}

const APP_ID = "console";
const COHORT = "stable";
const BUILD_ID = "next-payload-v1";
const CACHE_PREFIX = `impromptu-${APP_ID}-shell-${COHORT}-`;
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const PRECACHE_URLS = ["/offline.html", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  const requestedCohort = new URL(self.location.href).searchParams.get("cohort");
  event.waitUntil(
    requestedCohort === COHORT
      ? caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
      : Promise.reject(new Error("service worker release cohort mismatch")),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});

self.addEventListener("message", (event) => {
  const { type, reason } = event.data ?? {};
  if (type === "IMPROMPTU_GET_RELEASE_PIN") {
    event.ports[0]?.postMessage({ cohort: COHORT, buildId: BUILD_ID });
    return;
  }
  if (
    type !== "IMPROMPTU_ACTIVATE_UPDATE" ||
    (reason !== "SESSION_ENDED" && reason !== "OPERATOR_CONFIRMED")
  ) {
    return;
  }
  event.waitUntil(
    self.skipWaiting().then(() => {
      event.ports[0]?.postMessage({
        type: "IMPROMPTU_UPDATE_ACTIVATION_ACCEPTED",
        reason,
      });
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    requestUrl.origin !== self.location.origin ||
    event.request.mode !== "navigate"
  ) {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match("/offline.html")) ?? Response.error();
    }),
  );
});

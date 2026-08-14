const CACHE_NAME = "impromptu-stage-public-v1";
const APP_SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      ),
  );
});

async function serveRequest(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  try {
    return await fetch(request);
  } catch {
    if (request.mode === "navigate") {
      return (await caches.match("/index.html")) ?? Response.error();
    }
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin) {
    return;
  }

  event.respondWith(serveRequest(event.request));
});

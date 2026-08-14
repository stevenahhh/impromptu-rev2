import { resolve } from "node:path";

const backendOrigin = process.env.PRIVATE_BACKEND_ORIGIN;
if (backendOrigin === undefined) throw new Error("PRIVATE_BACKEND_ORIGIN is required");
const distributionRoot = resolve("apps/console/dist");
const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 44273,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/v1/")) {
      return fetch(`${backendOrigin}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
      });
    }
    const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const candidate = Bun.file(resolve(distributionRoot, `.${requestedPath}`));
    const file = (await candidate.exists())
      ? candidate
      : Bun.file(resolve(distributionRoot, "index.html"));
    const extension = file.name?.match(/\.[^.]+$/)?.[0] ?? ".html";
    return new Response(file, {
      headers: {
        "content-type": contentTypes[extension] ?? "application/octet-stream",
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      },
    });
  },
});

console.log(`console-origin listening on ${server.url}`);

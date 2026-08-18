export {};

let backendOrigin = process.env.PRIVATE_BACKEND_ORIGIN;
if (backendOrigin === undefined) throw new Error("PRIVATE_BACKEND_ORIGIN is required");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.TOPOLOGY_CONSOLE_PORT ?? "44273"),
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__test/backend") {
      const body: unknown = await request.json();
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        typeof (body as Record<string, unknown>).origin !== "string"
      ) {
        return Response.json({ error: "invalid_origin" }, { status: 400 });
      }
      backendOrigin = (body as { origin: string }).origin;
      return Response.json({ status: "updated" });
    }
    if (url.pathname.startsWith("/v1/")) {
      return fetch(`${backendOrigin}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

console.log(`console-origin listening on ${server.url}`);

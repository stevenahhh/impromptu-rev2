import { consoleDeckAssetOrigin } from "./next-runtime-config";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const SAFE_PATH_COMPONENT = /^[A-Za-z0-9._-]+$/;
const FORWARDED_RESPONSE_HEADERS = ["cache-control", "content-length", "content-type", "etag"];

export async function proxyDeckAsset(
  request: Request,
  path: readonly string[],
  fetcher: Fetcher = fetch,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  if (
    path.length < 2 ||
    path.some(
      (component) =>
        component === "." || component === ".." || !SAFE_PATH_COMPONENT.test(component),
    )
  ) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const target = new URL(
    `/v1/deck-assets/${path.map(encodeURIComponent).join("/")}`,
    consoleDeckAssetOrigin(),
  );
  const upstream = await fetcher(target, {
    method: request.method,
    headers: { accept: request.headers.get("accept") ?? "*/*" },
    redirect: "error",
  });
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("x-content-type-options", "nosniff");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

import { consolePrivateApiOrigin } from "./next-runtime-config";

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit & { readonly duplex?: "half" },
) => Promise<Response>;

export async function proxyPrivateApi(
  request: Request,
  path: readonly string[],
  fetcher: Fetcher = fetch,
): Promise<Response> {
  const target = new URL(
    `/v1/${path.map(encodeURIComponent).join("/")}`,
    consolePrivateApiOrigin(),
  );
  target.search = new URL(request.url).search;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetcher(target, {
    method: request.method,
    headers,
    ...(hasBody ? { body: request.body, duplex: "half" } : {}),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

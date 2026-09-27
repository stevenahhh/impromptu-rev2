import { consolePrivateApiOrigin } from "./next-runtime-config";

type ProxyInit = RequestInit & { readonly duplex?: "half" };

type Fetcher = (input: string | URL | Request, init?: ProxyInit) => Promise<Response>;

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
  const contentType = upstream.headers.get("content-type");
  const body =
    contentType?.includes("text/event-stream") || upstream.body === null
      ? upstream.body
      : await upstream.arrayBuffer();
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("transfer-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("connection");
  responseHeaders.delete("content-encoding");
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

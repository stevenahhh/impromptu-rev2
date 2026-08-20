import { proxyDeckAsset } from "../../../../../deck-asset-proxy";

type RouteContext = Readonly<{
  params: Promise<{ readonly path: string[] }>;
}>;

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return proxyDeckAsset(request, path);
}

export const GET = proxy;
export const HEAD = proxy;
